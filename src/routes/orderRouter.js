const express = require('express');
const config = require('../config.js');
const metrics = require('../metrics.js');
const logger = require('../logger.js');
const { Role, DB } = require('../database/database.js');
const { authRouter } = require('./authRouter.js');
const { asyncHandler, StatusCodeError, isNonEmptyString, toPositiveInt } = require('../endpointHelper.js');

const orderRouter = express.Router();

orderRouter.docs = [
  {
    method: 'GET',
    path: '/api/order/menu',
    description: 'Get the pizza menu',
    example: `curl localhost:3000/api/order/menu`,
    response: [{ id: 1, title: 'Veggie', image: 'pizza1.png', price: 0.0038, description: 'A garden of delight' }],
  },
  {
    method: 'PUT',
    path: '/api/order/menu',
    requiresAuth: true,
    description: 'Add an item to the menu',
    example: `curl -X PUT localhost:3000/api/order/menu -H 'Content-Type: application/json' -d '{ "title":"Student", "description": "No topping, no sauce, just carbs", "image":"pizza9.png", "price": 0.0001 }'  -H 'Authorization: Bearer tttttt'`,
    response: [{ id: 1, title: 'Student', description: 'No topping, no sauce, just carbs', image: 'pizza9.png', price: 0.0001 }],
  },
  {
    method: 'GET',
    path: '/api/order',
    requiresAuth: true,
    description: 'Get the orders for the authenticated user',
    example: `curl -X GET localhost:3000/api/order  -H 'Authorization: Bearer tttttt'`,
    response: { dinerId: 4, orders: [{ id: 1, franchiseId: 1, storeId: 1, date: '2024-06-05T05:14:40.000Z', items: [{ id: 1, menuId: 1, description: 'Veggie', price: 0.05 }] }], page: 1 },
  },
  {
    method: 'POST',
    path: '/api/order',
    requiresAuth: true,
    description: 'Create a order for the authenticated user',
    example: `curl -X POST localhost:3000/api/order -H 'Content-Type: application/json' -d '{"franchiseId": 1, "storeId":1, "items":[{ "menuId": 1, "description": "Veggie", "price": 0.05 }]}'  -H 'Authorization: Bearer tttttt'`,
    response: { order: { franchiseId: 1, storeId: 1, items: [{ menuId: 1, description: 'Veggie', price: 0.05 }], id: 1 }, jwt: '1111111111' },
  },
];

// getMenu
orderRouter.get(
  '/menu',
  asyncHandler(async (req, res) => {
    res.send(await DB.getMenu());
  })
);

// addMenuItem
orderRouter.put(
  '/menu',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    if (!req.user.isRole(Role.Admin)) {
      throw new StatusCodeError('unable to add menu item', 403);
    }

    const addMenuItemReq = req.body;
    if (!isNonEmptyString(addMenuItemReq?.title) || !isNonEmptyString(addMenuItemReq?.description) || !isNonEmptyString(addMenuItemReq?.image)) {
      return res.status(400).json({ message: 'title, description, and image are required' });
    }

    if (typeof addMenuItemReq?.price !== 'number' || !Number.isFinite(addMenuItemReq.price) || addMenuItemReq.price <= 0) {
      return res.status(400).json({ message: 'price must be a positive number' });
    }

    await DB.addMenuItem(addMenuItemReq);
    res.send(await DB.getMenu());
  })
);

// getOrders
orderRouter.get(
  '/',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    if (req.query.page !== undefined && toPositiveInt(req.query.page) === null) {
      return res.status(400).json({ message: 'invalid page' });
    }

    res.json(await DB.getOrders(req.user, req.query.page));
  })
);

// createOrder
orderRouter.post(
  '/',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    const orderReq = req.body;

    const franchiseId = toPositiveInt(orderReq?.franchiseId);
    const storeId = toPositiveInt(orderReq?.storeId);
    if (!franchiseId || !storeId) {
      return res.status(400).send({ message: 'valid franchiseId and storeId are required' });
    }

    if (!Array.isArray(orderReq.items) || orderReq.items.length === 0) {
      return res.status(400).send({ message: 'order must contain at least one item' });
    }

    if (orderReq.items.some((item) => !toPositiveInt(item?.menuId))) {
      return res.status(400).send({ message: 'each item must include a valid menuId' });
    }

    const franchise = await DB.getFranchise({ id: franchiseId });
    const storeBelongsToFranchise = franchise.stores.some((store) => store.id === storeId);
    if (!storeBelongsToFranchise) {
      return res.status(400).send({ message: 'invalid franchise/store combination' });
    }

    const menu = await DB.getMenu();
    const menuById = new Map(menu.map((item) => [item.id, item]));
    const normalizedItems = orderReq.items.map((item) => {
      const menuItem = menuById.get(item.menuId);
      if (!menuItem) {
        throw new StatusCodeError(`invalid menu item ${item.menuId}`, 400);
      }

      return {
        menuId: menuItem.id,
        description: menuItem.title || menuItem.description,
        price: menuItem.price,
      };
    });

    const normalizedOrderReq = {
      ...orderReq,
      franchiseId,
      storeId,
      items: normalizedItems,
    };

    const order = await DB.addDinerOrder(req.user, normalizedOrderReq);
    const start = Date.now();
    const pizzaCount = Array.isArray(order.items) ? order.items.length : 0;
    const totalRevenue = (order.items || []).reduce((sum, item) => sum + (item.price || 0), 0);

    try {
      const orderInfo = { diner: { id: req.user.id, name: req.user.name, email: req.user.email }, order };
      logger.factoryLogger(orderInfo);
      const r = await fetch(`${config.factory.url}/api/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${config.factory.apiKey}` },
        body: JSON.stringify(orderInfo),
      });
      const j = await r.json();
      const latencyMs = Date.now() - start;

      if (r.ok) {
        metrics.pizzaPurchase(true, latencyMs, totalRevenue, pizzaCount);
        res.send({ order, followLinkToEndChaos: j.reportUrl, jwt: j.jwt });
      } else {
        metrics.pizzaPurchase(false, latencyMs, 0, 0);
        res.status(500).send({ message: 'Failed to fulfill order at factory', followLinkToEndChaos: j.reportUrl });
      }
    } catch (err) {
      const latencyMs = Date.now() - start;
      metrics.pizzaPurchase(false, latencyMs, 0, 0);
      throw err;
    }
  })
);

module.exports = orderRouter;
