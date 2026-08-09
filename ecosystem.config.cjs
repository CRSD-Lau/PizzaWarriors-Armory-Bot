module.exports = {
  apps: [
    {
      name: "pizza-warriors-armory",
      cwd: "D:\\Wow Addons\\PizzaWarriors-Armory-Bot",
      script: "scripts/run-bot.mjs",
      interpreter: "C:\\Program Files\\nodejs\\node.exe",
      node_args: "--import tsx",
      windowsHide: true,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      time: true,
    },
  ],
};
