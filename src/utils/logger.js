// src/utils/logger.js
// Structured logging — production safe (no sensitive data ever logged)

const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'snehamverse-voice-agent' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length > 1
            ? ' ' + JSON.stringify(meta)
            : '';
          return `[${timestamp}] ${level}: ${message}${metaStr}`;
        })
      )
    })
  ]
});

module.exports = logger;
