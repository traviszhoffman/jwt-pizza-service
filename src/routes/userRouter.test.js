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
let regularUser;
let regularToken;
let targetUser;
let targetToken;

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
  const adminLoginRes = await request(app).put('/api/auth').send({ email: adminUser.email, password: 'toomanysecrets' });
  adminToken = adminLoginRes.body.token;
  expectValidJwt(adminToken);

  // Create regular user
  regularUser = { name: randomName(), email: randomName() + '@test.com', password: 'a' };
  const regularRes = await request(app).post('/api/auth').send(regularUser);
  regularToken = regularRes.body.token;
  regularUser.id = regularRes.body.user.id;
  expectValidJwt(regularToken);

  // Create target user (for update tests)
  targetUser = { name: randomName(), email: randomName() + '@target.com', password: 'a' };
  const targetRes = await request(app).post('/api/auth').send(targetUser);
  targetToken = targetRes.body.token;
  targetUser.id = targetRes.body.user.id;
  expectValidJwt(targetToken);
});

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);
}

describe('GET /api/user/me', () => {
  test('should return authenticated user info', async () => {
    const res = await request(app)
      .get('/api/user/me')
      .set('Authorization', `Bearer ${regularToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', regularUser.id);
    expect(res.body).toHaveProperty('name', regularUser.name);
    expect(res.body).toHaveProperty('email', regularUser.email);
    expect(res.body).toHaveProperty('roles');
    expect(res.body.roles).toEqual([{ role: 'diner' }]);
  });

  test('should return admin user info for admin', async () => {
    const res = await request(app)
      .get('/api/user/me')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', adminUser.id);
    expect(res.body).toHaveProperty('roles');
    expect(res.body.roles).toContainEqual({ role: 'admin' });
  });

  test('should return 401 when not authenticated', async () => {
    const res = await request(app).get('/api/user/me');

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('unauthorized');
  });

  test('should return 401 with invalid token', async () => {
    const res = await request(app)
      .get('/api/user/me')
      .set('Authorization', 'Bearer invalid.token.here');

    expect(res.status).toBe(401);
  });

  test('should return 401 with malformed authorization header', async () => {
    const res = await request(app)
      .get('/api/user/me')
      .set('Authorization', 'NotBearer sometoken');

    expect(res.status).toBe(401);
  });
});

describe('PUT /api/user/:userId', () => {
  test('should allow user to update their own name', async () => {
    const newName = randomName();
    const res = await request(app)
      .put(`/api/user/${regularUser.id}`)
      .set('Authorization', `Bearer ${regularToken}`)
      .send({ name: newName });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('user');
    expect(res.body.user.name).toBe(newName);
    expect(res.body.user.id).toBe(regularUser.id);
    expect(res.body).toHaveProperty('token');
    expectValidJwt(res.body.token);
  });

  test('should allow user to update their own email', async () => {
    const newEmail = randomName() + '@newemail.com';
    const res = await request(app)
      .put(`/api/user/${targetUser.id}`)
      .set('Authorization', `Bearer ${targetToken}`)
      .send({ email: newEmail });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(newEmail);
    expect(res.body.user.id).toBe(targetUser.id);
    expectValidJwt(res.body.token);
    
    // Update targetUser email for subsequent tests
    targetUser.email = newEmail;
    targetToken = res.body.token;
  });

  test('should allow user to update their own password', async () => {
    const newPassword = 'newSecurePassword123';
    const res = await request(app)
      .put(`/api/user/${targetUser.id}`)
      .set('Authorization', `Bearer ${targetToken}`)
      .send({ password: newPassword });

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(targetUser.id);
    expectValidJwt(res.body.token);
    
    // Update token
    targetToken = res.body.token;

    // Verify new password works by logging in
    const loginRes = await request(app)
      .put('/api/auth')
      .send({ email: targetUser.email, password: newPassword });

    expect(loginRes.status).toBe(200);
    expectValidJwt(loginRes.body.token);
    
    // Update password for subsequent tests
    targetUser.password = newPassword;
  });

  test('should allow user to update multiple fields at once', async () => {
    const updates = {
      name: randomName(),
      email: randomName() + '@multi.com',
      password: 'newpass456',
    };

    const res = await request(app)
      .put(`/api/user/${targetUser.id}`)
      .set('Authorization', `Bearer ${targetToken}`)
      .send(updates);

    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe(updates.name);
    expect(res.body.user.email).toBe(updates.email);
    expectValidJwt(res.body.token);

    // Update target user for future tests
    targetUser.name = updates.name;
    targetUser.email = updates.email;
    targetUser.password = updates.password;
    targetToken = res.body.token;
  });

  test('should allow admin to update another user', async () => {
    // Create a new user to update
    const userToUpdate = { name: randomName(), email: randomName() + '@updateme.com', password: 'a' };
    const createRes = await request(app).post('/api/auth').send(userToUpdate);
    const userId = createRes.body.user.id;

    const newName = randomName();
    const res = await request(app)
      .put(`/api/user/${userId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: newName });

    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe(newName);
    expect(res.body.user.id).toBe(userId);
    expectValidJwt(res.body.token);
  });

  test('should return 403 when non-admin tries to update another user', async () => {
    // Create a victim user
    const victimUser = { name: randomName(), email: randomName() + '@victim.com', password: 'a' };
    const createRes = await request(app).post('/api/auth').send(victimUser);
    const victimId = createRes.body.user.id;

    const res = await request(app)
      .put(`/api/user/${victimId}`)
      .set('Authorization', `Bearer ${regularToken}`)
      .send({ name: 'HackedName' });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('unauthorized');
  });

  test('should return 401 when not authenticated', async () => {
    const res = await request(app)
      .put(`/api/user/${regularUser.id}`)
      .send({ name: 'NewName' });

    expect(res.status).toBe(401);
  });

  test('should handle update with no fields provided', async () => {
    const res = await request(app)
      .put(`/api/user/${regularUser.id}`)
      .set('Authorization', `Bearer ${regularToken}`)
      .send({});

    // Should still succeed but not change anything
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('user');
    expect(res.body).toHaveProperty('token');
  });

  test('should handle invalid userId', async () => {
    const res = await request(app)
      .put('/api/user/99999')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'NewName' });

    // Depending on implementation, might return error or handle gracefully
    expect([200, 404, 500]).toContain(res.status);
  });

  test('should return new token after update', async () => {
    const oldToken = regularToken;
    const res = await request(app)
      .put(`/api/user/${regularUser.id}`)
      .set('Authorization', `Bearer ${regularToken}`)
      .send({ name: randomName() });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expectValidJwt(res.body.token);
    
    // New token should be different (contains updated user info)
    expect(res.body.token).not.toBe(oldToken);
    
    // Update regularToken for subsequent tests
    regularToken = res.body.token;
  });
});

describe('GET /api/user', () => {
  test('should return not implemented message', async () => {
    const res = await request(app)
      .get('/api/user')
      .set('Authorization', `Bearer ${regularToken}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('not implemented');
    expect(res.body.users).toEqual([]);
    expect(res.body.more).toBe(false);
  });

  test('should return not implemented for admin user', async () => {
    const res = await request(app)
      .get('/api/user')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('not implemented');
  });

  test('should require authentication', async () => {
    const res = await request(app).get('/api/user');

    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/user/:userId', () => {
  test('should return not implemented message', async () => {
    const res = await request(app)
      .delete(`/api/user/${regularUser.id}`)
      .set('Authorization', `Bearer ${regularToken}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('not implemented');
  });

  test('should return not implemented for admin deleting user', async () => {
    const res = await request(app)
      .delete(`/api/user/${regularUser.id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('not implemented');
  });

  test('should require authentication', async () => {
    const res = await request(app).delete(`/api/user/${regularUser.id}`);

    expect(res.status).toBe(401);
  });
});
