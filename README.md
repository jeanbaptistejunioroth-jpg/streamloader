# ⬇️ StreamLoader — Téléchargeur vidéo web, bot Telegram et application Windows

> Application full-stack Node.js : l'utilisateur colle un lien, choisit le format (MP4 / MP3, jusqu'à 4K) et suit la progression en temps réel. Disponible en site web, en bot Telegram et en application desktop Windows.

> ⚠️ **Code protégé — Tous droits réservés.** Ce dépôt est public uniquement pour la consultation (portfolio). Toute copie, réutilisation ou redistribution sans autorisation écrite de l'auteur est interdite. Voir [LICENSE](LICENSE).

![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=flat&logo=express&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?style=flat&logo=sqlite&logoColor=white)
![JWT](https://img.shields.io/badge/JWT-000000?style=flat&logo=jsonwebtokens&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-47848F?style=flat&logo=electron&logoColor=white)
![Telegram](https://img.shields.io/badge/Telegram_Bot_API-26A5E4?style=flat&logo=telegram&logoColor=white)
![FFmpeg](https://img.shields.io/badge/FFmpeg-007808?style=flat&logo=ffmpeg&logoColor=white)
![Nginx](https://img.shields.io/badge/Nginx-009639?style=flat&logo=nginx&logoColor=white)

---

## ✨ Fonctionnalités

- **Analyse du lien** et liste des formats disponibles (vidéo et audio)
- **Téléchargement avec progression en temps réel** (pourcentage, vitesse, temps restant) via **Server-Sent Events**
- **Transcodage automatique** avec FFmpeg : H.264 / AAC pour la vidéo, MP3 pour l'audio
- **Comptes utilisateurs** : inscription / connexion par **JWT**, mots de passe hachés avec **bcrypt**
- **Abonnement Premium** : paiement en ligne, activation via **webhook signé HMAC-SHA256** (comparaison à temps constant)
- **Limitation de débit** des requêtes (express-rate-limit) et quotas pour les comptes gratuits
- **Bot Telegram** : même service directement depuis une conversation
- **Application Windows (Electron)** réservée aux Premium, avec installeur NSIS personnalisé et interface bilingue FR / EN
- Pages légales (CGV / CGU, confidentialité, mentions légales)

---

## 🏗️ Architecture

```
Client web (SPA)  ─┐
Bot Telegram      ─┼──►  API REST Express  ──►  yt-dlp / FFmpeg (processus enfants)
App Electron      ─┘           │
                               ├──►  SQLite : utilisateurs, téléchargements, transactions
                               └──►  Passerelle de paiement  ◄── webhook signé HMAC
```

- **Monolithe Express** : routes REST, jobs de téléchargement suivis en mémoire, flux SSE
- **Processus enfants** (`spawn`) pour yt-dlp, ffmpeg et ffprobe, mise à jour automatique de yt-dlp au démarrage
- **Déploiement** : VPS Linux avec **Nginx** (reverse proxy) et **PM2**, ou plateforme PaaS via Nixpacks

---

## 👤 Auteur

**OTH Jean Baptiste Junior** — Ingénieur GESI · Développeur full-stack & IoT · Douala, Cameroun
[GitHub](https://github.com/jeanbaptistejunioroth-jpg) · [LinkedIn](https://www.linkedin.com/in/jean-baptiste-junior-oth-308935254) · [E-mail](mailto:Jeanbaptistejunioroth@gmail.com)
