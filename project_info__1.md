# StreamLoader Web — Vue d'ensemble du codebase

## Résumé
**StreamLoader** est une application full-stack Node.js de téléchargement de vidéos (YouTube, TikTok, Instagram, 1000+ sites via `yt-dlp`). Elle combine un **serveur Express** (API REST + téléchargements + paiements Premium) et un **bot Telegram**. L'utilisateur colle une URL, choisit un format (MP4/MP3, qualité jusqu'à 4K pour les Premium), et le serveur lance `yt-dlp` en arrière-plan avec suivi de progression temps réel via **Server-Sent Events (SSE)**. Le Premium est activé via un paiement **GeniusPay** avec webhook signé HMAC-SHA256.

**Le bug du screenshot** (« Erreur lors de l'initialisation du paiement GeniusPay: write EPROTO ... unrecognized name ... SSL alert number 112 ») est une **erreur SSL/TLS externe**, PAS un bug du code applicatif. Explication détaillée en section « Non-Obvious Behaviors ».

## Architecture

- **Pattern principal** : monolithe Express avec routes REST, processus enfants (`spawn`) pour yt-dlp/ffmpeg/ffprobe, flux SSE pour la progression, SQLite (better-sqlite3) pour les comptes et transactions, et un processus bot Telegram séparé.
- **Sous-systèmes** :
  1. **Auth** — inscription/connexion JWT (bcrypt, token 30 jours).
  2. **Analyse vidéo** — `POST /api/analyze` → yt-dlp `--dump-single-json`.
  3. **Téléchargement** — `POST /api/download/start` → job en mémoire → yt-dlp → transcodage ffmpeg → `GET /api/file/:jobId`.
  4. **Paiement Premium** — `POST /api/payment/initiate` → GeniusPay → webhook.
  5. **Bot Telegram** — même logique de téléchargement, mais limitée à 4 min / 30 téléchargements/jour pour les gratuits.
- **Stack** : Node.js ≥ 18, Express 4, axios, better-sqlite3, jsonwebtoken, bcryptjs, express-rate-limit, node-telegram-bot-api, uuid. **yt-dlp**, **ffmpeg**, **ffprobe** requis sur le système (installés via nixpacks en prod).
- **Démarrage** : `npm start` = `node server.js & node bot.js`. `server.js` écoute sur `PORT` (3000) et `bot.js` démarre le polling Telegram. Au boot, `server.js` lance aussi l'auto-update de yt-dlp.

## Structure du répertoire

```
projet final/
├── server.js           — Serveur Express principal (API, téléchargements, paiements, SSE)
├── bot.js              — Bot Telegram (téléchargement via messages/callback)
├── database.js         — Connexion SQLite + requêtes préparées (users, downloads, transactions)
├── index 1.2.html      — Frontend complet (SPA monofichier, i18n FR/EN, modal Premium)
├── public/index.html   — Copie du frontend servie par express.static
├── .env                — Config réelle (clés SANDBOX GeniusPay, tokens Telegram…)
├── .env.example        — Modèle de config commenté
├── DEPLOY_GUIDE.md     — Guide de déploiement
├── nixpacks.toml       — Build NixPacks (python, ffmpeg, yt-dlp, npm)
├── package.json        — Dépendances & scripts
├── data/               — SQLite (streamloader.db)
├── tmp/                — Fichiers temporaires de téléchargement
└── node_modules/
```

## Abstractions clés

### `initGeniusPay(txId, user, amount, currency)` — server.js
- **Responsabilité** : Crée une transaction de paiement côté GeniusPay via `axios.post` vers `GENIUSPAY_API_URL`, puis retourne l'URL de checkout.
- **Interface** : appelé depuis `POST /api/payment/initiate` avec `(txId, req.user, amount, currency)`.
- **Failures** : jette `new Error('Paiement indisponible : les clés GeniusPay ne sont pas configurées.')` si `GENIUSPAY_API_KEY` est vide ; sinon jette `new Error('Erreur lors de l\'initialisation du paiement GeniusPay: ' + …)` si l'appel axios échoue. **C'est exactement la ligne qui produit le message du screenshot.**

### `activatePremium(txId)` — server.js
- Marque la transaction `completed`, calcule la durée du forfait (`SUBSCRIPTION_PLANS[tx.plan].months`) et upgrade l'utilisateur en `premium`.
- Appelé depuis le webhook uniquement si la signature HMAC est valide.

### `isValidGeniusPaySignature(req)` — server.js
- Vérifie l'en-tête `x-geniuspay-signature` (format `sha256=…`) contre `HMAC-SHA256(GENIUSPAY_WEBHOOK_SECRET, req.rawBody)` avec `crypto.timingSafeEqual`.
- Sans `GENIUSPAY_WEBHOOK_SECRET`, retourne toujours `false`.

### `ytdlpInfo(url)` / job de téléchargement — server.js
- `getVideoFormatSelector(targetHeight)` → `bestvideo[height<=X][vcodec!=none]+bestaudio[acodec!=none]/best[height<=X]`.
- Le job (`downloadJobs` Map) suit `{ status, percent, speed, eta, total, filepath, error … }` et émet des SSE via `sseEmit`.
- Après yt-dlp : `transcodeVideo()` (H.264/AAC + faststart) ou `transcodeAudio()` (MP3).

## Flux de données — Paiement Premium (celui qui échoue)

1. **Frontend** (`index 1.2.html` → modal Premium) : l'utilisateur clique « Payer maintenant 900 FCFA ».
2. Le frontend appelle `POST /api/payment/initiate` avec `{ provider: 'geniuspay', currency: 'XAF', plan: 'monthly' }` (Bearer token requis → `authMiddleware`).
3. `server.js` calcule `getPlanAmount('monthly', 'XAF')` = `1.5 USD × 600 XAF` = **900`** (c'est le « 900 FCFA » du screenshot ; la constante `PRICE_FCFA = 1200` n'est plus utilisée pour ce calcul).
4. `queries.createTransaction.run(txId, user.id, 'geniuspay', 900, 'monthly')` insère la transaction.
5. **`initGeniusPay()`** fait `axios.post('https://api.geniuspay.com/v1/payments', { … }, { headers: { Authorization: Bearer <apiKey>, X-Secret-Key: <apiSecret> }, timeout: 10000 })`.
6. **ÉCHEC SSL** : la poignée de main TLS échoue → le `catch` jette `Erreur lors de l'initialisation du paiement GeniusPay: write EPROTO 48670000...`.
7. `server.js` répond `res.status(500).json({ error: e.message })`.
8. Le frontend affiche ce message dans la zone d'erreur du modal (exactement le texte rouge du screenshot).

## Comportements non-évidents & décisions de conception

### ★ POURQUOI CETTE ERREUR APPARAÎT (la réponse à « pourquoi ça fait ça ?? »)

Le message vient de `server.js` ligne ~630, dans le `catch` de `initGeniusPay()` :

```js
throw new Error('Erreur lors de l\'initialisation du paiement GeniusPay: ' + (err.response?.data?.message || err.message));
```

Le suffixe `write EPROTO 48670000:error:0A000458:SSL routines:ssl3_read_bytes:tlsv1 unrecognized name:openssl(ssl/record_layer_s3.c:918:SSL alert number 112` est le **`err.message`** renvoyé par Node.js/OpenSSL après que `axios.post('https://api.geniuspay.com/v1/payments')` a échoué.

**Ce que ça signifie :**
- `EPROTO` = erreur de protocole pendant la poignée de main TLS.
- `SSL alert number 112` = alerte TLS **`unrecognized_name`**.
- Concrètement, le client Node envoie **SNI = `api.geniuspay.com`** dans le `ClientHello`, et le serveur au bout de la connexion **ne reconnaît pas ce nom d'hôte**. Il répond par l'alerte 112 et la connexion est tuée.

**Racine du problème (pas un bug de ton code) :**
1. **`.env` utilise des clés SANDBOX** (`sk_sandbox_nkPsy…`, `ss_sandbox_xeEEP…`) avec le commentaire « Clés SANDBOX — à remplacer par les clés de PRODUCTION quand le compte sera validé ».
2. **`GENIUSPAY_API_URL = https://api.geniuspay.com/v1/payments`** — ce nom d'hôte ne résout pas vers un serveur qui possède un certificat TLS pour `api.geniuspay.com`, OU le sous-domaine `api.` n'est pas provisionné. Le serveur qui répond ne reconnaît pas ce SNI, d'où l'alerte 112.
3. L'appel axios **ne désactive pas la validation TLS** et il n'y a **aucun proxy/intercepteur** configuré — donc Node applique strictement la vérification du certificat.

**Ce qui se passe réellement :** le compte GeniusPay n'est pas validé/provisionné, ou l'URL API documentée dans `.env.example` est un **placeholder** qui n'existe pas réellement à cet hôte. Tant que `api.geniuspay.com` n'est pas un endpoint réel avec un certificat valide pour ce hostname, ce paiement échouera **toujours** avec cette erreur, quel que soit le code.

**Pour le résoudre (à faire en Act Mode, pas ici) :** remplacer `GENIUSPAY_API_URL` par la **vraie** URL d'API de production fournie par GeniusPay, et utiliser des clés API **de production** (pas sandbox). Vérifier que `api.geniuspay.com` (ou le domaine réel) répond bien avec un certificat valide pour ce hostname.

### Autres points non-évidents
- **`PRICE_FCFA = 1200` est un vestige** : le prix affiché (900 FCFA) vient de `getPlanAmount('monthly', 'XAF') = 1.5 × 600 = 900`, pas de `PRICE_FCFA`. Ce constant n'est utilisé que comme valeur par défaut du paramètre `amount` de `initGeniusPay`.
- **`app.set('trust proxy', 1)`** est essentiel en prod (Railway/Nginx) pour que `req.ip` soit l'IP réelle du client, sinon les rate limiters et la limite quotidienne de 30 téléchargements s'appliquent à l'IP du proxy.
- **`req.rawBody`** est capturé par le middleware `express.json` avec `verify` pour permettre la vérification HMAC du webhook GeniusPay. Sans cela, le webhook serait toujours 401.
- **CORS strict en prod** : seule l'origine dans `APP_URL` / `ALLOWED_ORIGINS` est autorisée ; jamais `*` avec `credentials`.
- **Transcodage vidéo** : après téléchargement, toujours re-encode l'audio en **AAC** (Opus n'est pas lisible en MP4 sur iPhone) et ajoute `+faststart`.
- **Fichiers à usage unique** : `GET /api/file/:jobId` supprime le fichier temporaire après envoi.
- **Le bot Telegram** applique `FREE_MAX_DURATION = 240` secondes (4 min) pour les gratuits, en plus de la limite de 30/jour.

## Référence des modules

| Fichier | Rôle |
|---------|------|
| `server.js` | Serveur Express : auth, analyse, téléchargement (SSE), fichiers, paiements (GeniusPay), webhook, pages retour. |
| `bot.js` | Bot Telegram : `/start`, analyse, callback `dl\|vid\|key` / `dl\|aud\|key`, conversion, envoi de fichier. |
| `database.js` | SQLite : connexion + requêtes préparées `users`, `downloads`, `transactions`. |
| `index 1.2.html` | Frontend SPA monofichier : hero, widget URL, cartes formats, modal Premium (GeniusPay), i18n FR/EN. |
| `public/index.html` | Copie servie statiquement par Express. |
| `.env` | Config réelle : clés GeniusPay SANDBOX, token Telegram, JWT secret, DB_PATH. |
| `nixpacks.toml` | Build de prod : python311, ffmpeg, `pip install yt-dlp`, `npm install --production`, démarrage `node server.js & node bot.js`. |

## Ordre de lecture suggéré (pour comprendre le bug)

1. `server.js` → `initGeniusPay()` + `POST /api/payment/initiate` — **la source exacte de l'erreur**.
2. `.env` → les valeurs `GENIUSPAY_API_KEY`, `GENIUSPAY_API_SECRET`, `GENIUSPAY_API_URL` — **la cause racine** (clés sandbox + URL de domaine non provisionné).
3. `server.js` → `isValidGeniusPaySignature()` — comprends comment le webhook validera le paiement une fois l'API fonctionnelle.
4. `index 1.2.html` → modal Premium / bouton « Payer maintenant » — d'où part l'appel réseau.
5. `server.js` → `getPlanAmount()` + `SUBSCRIPTION_PLANS` — d'où sortent les 900 FCFA.
