# Pourquoi ça fait ça ? — Erreur SSL GeniusPay

## Réponse courte
Cette erreur **n'est pas un bug de ton code**. C'est un échec de **poignée de main TLS** entre ton serveur Node.js et le domaine `api.geniuspay.com` que tu as configuré dans `.env`. Le serveur au bout de la connexion **ne reconnaît pas le nom d'hôte** `api.geniuspay.com` → il renvoie l'alerte TLS `112` (`unrecognized_name`) et coupe la connexion. Résultat : `EPROTO` + `SSL alert number 112`.

## Où ça se passe exactement

L'erreur vient de la fonction `initGeniusPay()` dans **`server.js`** (ligne ~630), dans le `catch` de l'appel `axios.post` :

```js
async function initGeniusPay(txId, user, amount, currency) {
  ...
  const response = await axios.post(
    process.env.GENIUSPAY_API_URL || 'https://api.geniuspay.com/v1/payments',
    { ... },
    { headers: { Authorization: `Bearer ${apiKey}`, 'X-Secret-Key': apiSecret, ... }, timeout: 10_000 }
  );
  ...
  } catch (err) {
    console.warn('[GeniusPay API Call]', err.response?.data || err.message);
    throw new Error('Erreur lors de l\'initialisation du paiement GeniusPay: ' + (err.response?.data?.message || err.message));
  }
}
```

Le message affiché à l'écran = `'Erreur lors de l'initialisation du paiement GeniusPay: '` + **le `err.message` renvoyé par OpenSSL**.

## Décodage du message d'erreur

```
write EPROTO 48670000:error:0A000458:SSL routines:ssl3_read_bytes:tlsv1 unrecognized name:openssl(ssl/record_layer_s3.c:918:SSL alert number 112
```

| Morceau | Signification |
|---------|---------------|
| `EPROTO` | Erreur de **protocole** pendant la poignée de main TLS |
| `tlsv1 unrecognized name` | Le **SNI** (Server Name Indication) envoyé par le client (`api.geniuspay.com`) n'est **pas reconnu** par le serveur |
| `SSL alert number 112` | Alerte TLS **`unrecognized_name`** — le serveur refuse l'hôte |

## La cause racine (3 faits)

1. **`.env` utilise des clés SANDBOX** :
   - `GENIUSPAY_API_KEY=sk_sandbox_nkPsyY3WkbOmb3A4813lbSmNFwQQSrkT`
   - `GENIUSPAY_API_SECRET=ss_sandbox_xeEEPA25bXNPZrRVWaXW4XbF8OT2P6hR2CYwreSUYB9XcM6w`
   - Ton propre commentaire dans `.env` dit : *« ⚠️ Clés SANDBOX — à remplacer par les clés de PRODUCTION quand le compte sera validé »*.

2. **`GENIUSPAY_API_URL = https://api.geniuspay.com/v1/payments`** est un **placeholder / domaine non provisionné**. Le sous-domaine `api.geniuspay.com` ne possède pas de certificat TLS valide pour ce hostname (ou ne résout pas vers un serveur qui le reconnaît). C'est pour ça que la poignée de main échoue avec `unrecognized name`.

3. Ton code **n'a aucun contournement TLS** (pas de `NODE_TLS_REJECT_UNAUTHORIZED=0`, pas d'intercepteur axios, pas de proxy). Donc Node.js applique **strictement** la validation du certificat → l'erreur est remontée telle quelle.

## Conclusion
- Le compte GeniusPay **n'est pas encore validé/provisionné** côté GeniusPay, OU l'URL API est fausse.
- Tant que `GENIUSPAY_API_URL` pointe vers un hôte qui n'a pas de certificat valide pour ce nom, **ce paiement échouera TOUJOURS** avec cette erreur, peu importe le code.
- Le frontend et la logique de prix sont, eux, corrects : le « 900 FCFA » vient de `getPlanAmount('monthly', 'XAF') = 1.5 USD × 600 XAF = 900` (la constante `PRICE_FCFA = 1200` est un vestige inutilisé pour ce calcul).

## Ce qu'il faudra faire (en Act Mode, pas ici)
1. Remplacer `GENIUSPAY_API_URL` par la **vraie URL d'API de production** fournie par GeniusPay (pas `api.geniuspay.com` si c'est un domaine inexistant).
2. Utiliser des **clés API de production** (remplacer `sk_sandbox_...` / `ss_sandbox_...` par les clés réelles).
3. Vérifier que le domaine réel répond avec un **certificat SSL valide** pour ce hostname (tester avec un `curl https://<ton-domaine>/...`).

---

## Complément — Vue d'ensemble du codebase (sauvegardée dans `project_info__1.md`)

**StreamLoader** est une app full-stack Node.js de téléchargement vidéo (yt-dlp) avec :
- **Serveur Express** (`server.js`) : auth JWT, analyse vidéo, téléchargements avec progression SSE, transcodage ffmpeg (H.264/AAC), paiements GeniusPay + webhook HMAC-SHA256.
- **Bot Telegram** (`bot.js`) : même logique, limitée à 4 min / 30 téléchargements/jour pour les gratuits.
- **Frontend SPA monofichier** (`index 1.2.html`) : i18n FR/EN, modal Premium (GeniusPay), cartes de formats.
- **SQLite** (`database.js`) : comptes, logs de téléchargements, transactions.

**Flux du paiement qui échoue :**
1. Clic sur « Payer maintenant 900 FCFA » → `POST /api/payment/initiate` (Bearer token requis).
2. `getPlanAmount('monthly','XAF')` = 900 FCFA → `createTransaction`.
3. `initGeniusPay()` → `axios.post('https://api.geniuspay.com/v1/payments')` → **échec TLS**.
4. `res.status(500).json({ error })` → le frontend affiche le message rouge.

**Autres points notables :**
- `PRICE_FCFA = 1200` est un vestige — ne sert plus au prix affiché.
- `app.set('trust proxy', 1)` est critique en prod pour les rate limiters / la limite de 30 téléchargements/jour.
- `req.rawBody` est capté via `express.json({ verify })` pour permettre la vérification HMAC du webhook.
- CORS strict en prod : jamais `*` avec `credentials`.
- Les fichiers téléchargés sont à usage unique (`/api/file/:jobId` les supprime après envoi).