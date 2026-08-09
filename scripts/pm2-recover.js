"use strict";

const pm2 = require("C:/Users/neil_/AppData/Roaming/npm/node_modules/pm2");
const appName = "pizza-warriors-armory";

function finish(code) {
  pm2.disconnect();
  process.exitCode = code;
}

pm2.connect((connectError) => {
  if (connectError) {
    console.error(connectError.message);
    process.exitCode = 1;
    return;
  }

  pm2.list((listError, processes) => {
    if (listError) {
      console.error(listError.message);
      finish(1);
      return;
    }

    const bot = processes.find((process) => process.name === appName);
    if (bot?.pm2_env?.status === "online") {
      finish(0);
      return;
    }

    pm2.resurrect((resurrectError) => {
      if (resurrectError) {
        console.error(resurrectError.message);
        finish(1);
        return;
      }

      finish(0);
    });
  });
});
