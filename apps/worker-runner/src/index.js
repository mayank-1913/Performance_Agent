'use strict';

const { LifecycleManager, STATUS } = require('./lifecycle');
const { buildK6Env, maskEnv } = require('./envInjector');
const { redactLine, RingBuffer } = require('./streamHandler');
const { spawnK6, killTree, resolveK6Bin } = require('./processManager');
const {
  buildK6CommandArgs,
  validateSpawnInputs,
  buildCommandPreview,
} = require('./commandBuilder');

module.exports = {
  LifecycleManager,
  STATUS,
  buildK6Env,
  maskEnv,
  redactLine,
  RingBuffer,
  spawnK6,
  killTree,
  resolveK6Bin,
  buildK6CommandArgs,
  validateSpawnInputs,
  buildCommandPreview,
};
