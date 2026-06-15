module.exports = {
  apps: [
    {
      name: 'warmup-agent',
      script: 'index.js',
      cwd: '/home/santhosham/warmup-agent',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production'
      },
      error_file: '/home/santhosham/warmup-agent/logs/pm2-error.log',
      out_file: '/home/santhosham/warmup-agent/logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      restart_delay: 5000,
      max_restarts: 20,
      min_uptime: '10s'
    }
  ]
};
