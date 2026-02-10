const request = require('supertest');
const app = require('../service');
const { Role, DB } = require('../database/database.js');

if (process.env.VSCODE_INSPECTOR_OPTIONS) {
  jest.setTimeout(60 * 1000 * 5); // 5 minutes
}

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

let adminUser;
let adminToken;
let franchiseeUser;
let franchiseeToken;
let regularUser;
let regularToken;

async function createAdminUser() {
  let user = { password: 'toomanysecrets', roles: [{ role: Role.Admin }] };
  user.name = randomName();
  user.email = user.name + '@admin.com';
  user = await DB.addUser(user);
  return { ...user, password: 'toomanysecrets' };
}

beforeAll(async () => {
  // Create admin user
  adminUser = await createAdminUser();
  let loginRes = await request(app).put('/api/auth').send({ email: adminUser.email, password: 'toomanysecrets' });
  adminToken = loginRes.body.token;
  expectValidJwt(adminToken);

  // Create regular user (will become franchisee)
  franchiseeUser = { name: randomName(), email: randomName() + '@franchisee.com', password: 'a' };
  const registerRes = await request(app).post('/api/auth').send(franchiseeUser);
  franchiseeToken = registerRes.body.token;
  franchiseeUser.id = registerRes.body.user.id;
  expectValidJwt(franchiseeToken);

  // Create another regular user (diner)
  regularUser = { name: randomName(), email: randomName() + '@test.com', password: 'a' };
  const regularRes = await request(app).post('/api/auth').send(regularUser);
  regularToken = regularRes.body.token;
  regularUser.id = regularRes.body.user.id;
  expectValidJwt(regularToken);
});

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);
}

describe('GET /api/franchise', () => {
  test('should list all franchises', async () => {
    const res = await request(app).get('/api/franchise');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('franchises');
    expect(Array.isArray(res.body.franchises)).toBe(true);
    expect(res.body).toHaveProperty('more');
  });

  test('should support pagination with page and limit', async () => {
    const res = await request(app).get('/api/franchise?page=0&limit=5');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('franchises');
    expect(res.body).toHaveProperty('more');
  });

  test('should support name filtering', async () => {
    // Create a franchise with a unique name
    const uniqueName = 'TestFranchise' + randomName();
    await request(app)
      .post('/api/franchise')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: uniqueName, admins: [{ email: franchiseeUser.email }] });

    const res = await request(app).get(`/api/franchise?name=${uniqueName}`);
    expect(res.status).toBe(200);
    expect(res.body.franchises.length).toBeGreaterThan(0);
  });
});

describe('GET /api/franchise/:userId', () => {
  test('should get user franchises when authenticated as the user', async () => {
    const res = await request(app)
      .get(`/api/franchise/${franchiseeUser.id}`)
      .set('Authorization', `Bearer ${franchiseeToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('should get user franchises when authenticated as admin', async () => {
    const res = await request(app)
      .get(`/api/franchise/${franchiseeUser.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('should return empty array when user tries to access another user franchises', async () => {
    const res = await request(app)
      .get(`/api/franchise/${franchiseeUser.id}`)
      .set('Authorization', `Bearer ${regularToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('should return 401 when not authenticated', async () => {
    const res = await request(app).get(`/api/franchise/${franchiseeUser.id}`);
    expect(res.status).toBe(401);
  });

  test('should handle invalid userId', async () => {
    const res = await request(app)
      .get('/api/franchise/99999')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('POST /api/franchise', () => {
  test('should create franchise when authenticated as admin', async () => {
    const franchiseName = 'NewFranchise' + randomName();
    const res = await request(app)
      .post('/api/franchise')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: franchiseName, admins: [{ email: franchiseeUser.email }] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');
    expect(res.body.name).toBe(franchiseName);
    expect(res.body.admins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          email: franchiseeUser.email,
        }),
      ])
    );
  });

  test('should return 403 when non-admin tries to create franchise', async () => {
    const franchiseName = 'UnauthorizedFranchise' + randomName();
    const res = await request(app)
      .post('/api/franchise')
      .set('Authorization', `Bearer ${regularToken}`)
      .send({ name: franchiseName, admins: [{ email: franchiseeUser.email }] });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('unable to create a franchise');
  });

  test('should return 401 when not authenticated', async () => {
    const franchiseName = 'UnauthFranchise' + randomName();
    const res = await request(app)
      .post('/api/franchise')
      .send({ name: franchiseName, admins: [{ email: franchiseeUser.email }] });

    expect(res.status).toBe(401);
  });

  test('should handle missing franchise name', async () => {
    const res = await request(app)
      .post('/api/franchise')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ admins: [{ email: franchiseeUser.email }] });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test('should handle missing admins', async () => {
    const franchiseName = 'NoAdminFranchise' + randomName();
    const res = await request(app)
      .post('/api/franchise')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: franchiseName });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('DELETE /api/franchise/:franchiseId', () => {
  let testFranchiseId;

  beforeEach(async () => {
    // Create a franchise to delete
    const franchiseName = 'ToDelete' + randomName();
    const createRes = await request(app)
      .post('/api/franchise')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: franchiseName, admins: [{ email: franchiseeUser.email }] });
    testFranchiseId = createRes.body.id;
  });

  test('should delete franchise successfully', async () => {
    const res = await request(app).delete(`/api/franchise/${testFranchiseId}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('franchise deleted');
  });

  test('should handle invalid franchise ID', async () => {
    const res = await request(app).delete('/api/franchise/99999');

    // Should still return 200 based on current implementation
    expect(res.status).toBe(200);
  });
});

describe('POST /api/franchise/:franchiseId/store', () => {
  let testFranchiseId;

  beforeEach(async () => {
    // Create a franchise
    const franchiseName = 'StoreTestFranchise' + randomName();
    const createRes = await request(app)
      .post('/api/franchise')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: franchiseName, admins: [{ email: franchiseeUser.email }] });
    testFranchiseId = createRes.body.id;
  });

  test('should create store when authenticated as franchise admin', async () => {
    const storeName = 'Store' + randomName();
    const res = await request(app)
      .post(`/api/franchise/${testFranchiseId}/store`)
      .set('Authorization', `Bearer ${franchiseeToken}`)
      .send({ name: storeName });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');
    expect(res.body.name).toBe(storeName);
  });

  test('should create store when authenticated as global admin', async () => {
    const storeName = 'AdminStore' + randomName();
    const res = await request(app)
      .post(`/api/franchise/${testFranchiseId}/store`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: storeName });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');
    expect(res.body.name).toBe(storeName);
  });

  test('should return 403 when non-franchise-admin tries to create store', async () => {
    const storeName = 'UnauthorizedStore' + randomName();
    const res = await request(app)
      .post(`/api/franchise/${testFranchiseId}/store`)
      .set('Authorization', `Bearer ${regularToken}`)
      .send({ name: storeName });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('unable to create a store');
  });

  test('should return 401 when not authenticated', async () => {
    const storeName = 'UnauthStore' + randomName();
    const res = await request(app)
      .post(`/api/franchise/${testFranchiseId}/store`)
      .send({ name: storeName });

    expect(res.status).toBe(401);
  });

  test('should return 403 for invalid franchise ID', async () => {
    const storeName = 'InvalidFranchiseStore' + randomName();
    const res = await request(app)
      .post('/api/franchise/99999/store')
      .set('Authorization', `Bearer ${franchiseeToken}`)
      .send({ name: storeName });

    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/franchise/:franchiseId/store/:storeId', () => {
  let testFranchiseId;
  let testStoreId;

  beforeEach(async () => {
    // Create a franchise
    const franchiseName = 'DeleteStoreTestFranchise' + randomName();
    const createFranchiseRes = await request(app)
      .post('/api/franchise')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: franchiseName, admins: [{ email: franchiseeUser.email }] });
    testFranchiseId = createFranchiseRes.body.id;

    // Create a store
    const storeName = 'ToDeleteStore' + randomName();
    const createStoreRes = await request(app)
      .post(`/api/franchise/${testFranchiseId}/store`)
      .set('Authorization', `Bearer ${franchiseeToken}`)
      .send({ name: storeName });
    testStoreId = createStoreRes.body.id;
  });

  test('should delete store when authenticated as franchise admin', async () => {
    const res = await request(app)
      .delete(`/api/franchise/${testFranchiseId}/store/${testStoreId}`)
      .set('Authorization', `Bearer ${franchiseeToken}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('store deleted');
  });

  test('should delete store when authenticated as global admin', async () => {
    // Create another store
    const storeName = 'AdminDeleteStore' + randomName();
    const createStoreRes = await request(app)
      .post(`/api/franchise/${testFranchiseId}/store`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: storeName });
    const storeId = createStoreRes.body.id;

    const res = await request(app)
      .delete(`/api/franchise/${testFranchiseId}/store/${storeId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('store deleted');
  });

  test('should return 403 when non-franchise-admin tries to delete store', async () => {
    const res = await request(app)
      .delete(`/api/franchise/${testFranchiseId}/store/${testStoreId}`)
      .set('Authorization', `Bearer ${regularToken}`);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('unable to delete a store');
  });

  test('should return 401 when not authenticated', async () => {
    const res = await request(app).delete(`/api/franchise/${testFranchiseId}/store/${testStoreId}`);

    expect(res.status).toBe(401);
  });

  test('should return 403 for invalid franchise ID', async () => {
    const res = await request(app)
      .delete(`/api/franchise/99999/store/${testStoreId}`)
      .set('Authorization', `Bearer ${franchiseeToken}`);

    expect(res.status).toBe(403);
  });

  test('should handle invalid store ID', async () => {
    const res = await request(app)
      .delete(`/api/franchise/${testFranchiseId}/store/99999`)
      .set('Authorization', `Bearer ${franchiseeToken}`);

    // Should still return 200 based on current implementation
    expect(res.status).toBe(200);
  });
});
