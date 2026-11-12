// Config PM2 — garde server.js et bot.js en vie en permanence sur le VPS
// (redémarrage automatique en cas de crash ou de reboot du serveur).
// Utilisation : pm2 start deploy/ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'streamloader-web',
      script: 'server.js',
      cwd: __dirname + '/..',
      env: { NODE_ENV: 'production' },
      max_restarts: 10,
      restart_delay: 3000,
    },
    {
      name: 'streamloader-bot',
      script: 'bot.js',
      cwd: __dirname + '/..',
      env: { NODE_ENV: 'production' },
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
