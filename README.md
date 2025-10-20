![World Domination](/logo.png)

# World Domination

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg) [![Contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg?style=flat)](https://github.com/fredrik-stigsson/world-domination/issues) ![Version 1.0.1](https://img.shields.io/badge/version-1.0.0-blue)

World Domination is a classic game of global conquest. Command your armies across 42 territories, forge alliances or betray friends, and use cunning strategy to eliminate all rivals in this epic battle for world supremacy.

---

## Installation
```bash
cd /var/www (if you want the service to work out of the box)
git clone https://github.com/fredrik-stigsson/world-domination.git
cd world-domination
npm install --omit=dev
```

---

## Enable service on production server
```bash
cp /var/www/world-domination/world-domination.service /etc/systemd/system/world-domination.service
systemctl daemon-reload
systemctl enable world-domination
systemctl start world-domination
```

## 🚀 Quick Play

**Ready to conquer the world? [Play it now!](https://games.annytab.com/world-domination/)**