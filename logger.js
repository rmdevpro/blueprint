'use strict';

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

const rawLevel = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
const _currentLevel = LOG_LEVELS[rawLevel] ?? LOG_LEVELS.INFO;

if (LOG_LEVELS[rawLevel] === undefined) {
  process.stdout.write(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'WARN',
      message: `Unrecognized LOG_LEVEL '${rawLevel}', defaulting to INFO`,
    }) + '\n',
  );
}

function emit(level, stream, message, context) {
  if (LOG_LEVELS[level] < _currentLevel) return;
  const entry = { timestamp: new Date().toISOString(), level, message };
  if (context && typeof context === 'object') {
    for (const [k, v] of Object.entries(context)) {
      if (k !== 'timestamp' && k !== 'level' && k !== 'message') {
        entry[k] = v;
      }
    }
  }
  stream.write(JSON.stringify(entry) + '\n');
}

module.exports = {
  debug(message, context = {}) {
    emit('DEBUG', process.stdout, message, context);
  },
  info(message, context = {}) {
    emit('INFO', process.stdout, message, context);
  },
  warn(message, context = {}) {
    emit('WARN', process.stdout, message, context);
  },
  error(message, context = {}) {
    emit('ERROR', process.stderr, message, context);
  },
};
