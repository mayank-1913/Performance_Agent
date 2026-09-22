'use strict';

const { Router } = require('express');
const { getHealth } = require('./health.controller');

const router = Router();

router.get('/', getHealth);

module.exports = router;
