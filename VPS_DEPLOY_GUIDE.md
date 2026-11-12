# StreamLoader — Guide de déploiement VPS (Ubuntu), de A à Z

Ce guide part du principe que tu viens d'acheter un VPS Ubuntu tout neuf, sur lequel rien
n'est installé, et t'accompagne jusqu'à un site en ligne, en HTTPS, qui redémarre tout seul
en cas de crash ou de reboot. Chaque commande est à copier-coller telle quelle (en
remplaçant les valeurs entre `<...>` par les tiennes).

**Temps estimé : 45 à 90 minutes**, DNS mis à part (qui peut prendre jusqu'à 24h à se
propager, voir Partie 7).

---

## Sommaire

0. Ce dont tu as besoin avant de commencer
1. Première connexion et sécurisation du VPS
2. Installer les dépendances système
3. Transférer le projet sur le VPS
4. Configurer le fichier `.env` de production
5. Installer les dépendances du projet
6. Lancer l'application avec PM2
6 bis. (Optionnel) Envoyer des fichiers jusqu'à 100 Mo sur Telegram
7. Nom de domaine (DNS)
8. Reverse proxy nginx
9. HTTPS avec Let's Encrypt (certbot)
10. Pare-feu final
11. Checklist de vérification complète
12. Maintenance (mises à jour, sauvegardes, logs)
13. Dépannage courant

---

## 0. Ce dont tu as besoin avant de commencer

- **L'IP de ton VPS** et le **mot de passe root** (ou la clé SSH) fournis par ton hébergeur
  (envoyés par email à l'achat, ou visibles dans le panneau de contrôle de l'hébergeur)
- **Un nom de domaine** (ex. `streamloader.com`) — achetable chez Namecheap, OVH, Google
  Domains, etc. si tu n'en as pas encore. Sans ça, tu peux déployer et tester via l'IP nue,
  mais **pas de HTTPS possible** (Let's Encrypt exige un nom de domaine).
- Les vraies clés de production : **GeniusPay** (pas les clés sandbox), un **token Telegram**
  régénéré (voir partie 4), une **clé Shazam/RapidAPI** si tu utilises le bot.
- PowerShell sur ta machine Windows (déjà utilisé tout du long dans ce projet — il inclut un
  client SSH/SCP natif, pas besoin d'installer PuTTY).

---

## 1. Première connexion et sécurisation du VPS

### 1.1 Se connecter en SSH pour la première fois

Depuis PowerShell sur ta machine :

```powershell
ssh root@<IP_DU_VPS>
```

Tape `yes` si on te demande de confirmer l'empreinte du serveur, puis entre le mot de passe
root fourni par ton hébergeur (les caractères ne s'affichent pas en tapant, c'est normal).

### 1.2 Mettre à jour le système

Une fois connecté (tu es maintenant **sur le VPS**, plus sur ta machine Windows) :

```bash
apt update && apt upgrade -y
```

### 1.3 Créer un utilisateur non-root

Travailler en root en permanence est risqué (une erreur de commande peut casser tout le
système). On crée un utilisateur dédié :

```bash
adduser streamloader
# Choisis un mot de passe fort quand demandé, le reste (nom complet etc.) est optionnel — Entrée pour passer.

usermod -aG sudo streamloader
```

### 1.4 Configurer l'authentification par clé SSH (fortement recommandé)

**Depuis ta machine Windows**, dans un **nouveau** PowerShell (laisse la session SSH root
ouverte pour l'instant) :

```powershell
ssh-keygen -t ed25519 -C "streamloader-vps"
# Accepte l'emplacement par défaut (Entrée), choisis une passphrase ou laisse vide (Entrée x2)

Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub
```

Copie la ligne affichée (elle commence par `ssh-ed25519 AAAA...`). Retourne dans la session
SSH **root** sur le VPS et exécute :

```bash
mkdir -p /home/streamloader/.ssh
nano /home/streamloader/.ssh/authorized_keys
```

Colle la clé publique copiée (clic droit dans le terminal PowerShell pour coller), puis
`Ctrl+O`, Entrée, `Ctrl+X` pour sauvegarder et quitter nano. Ensuite :

```bash
chown -R streamloader:streamloader /home/streamloader/.ssh
chmod 700 /home/streamloader/.ssh
chmod 600 /home/streamloader/.ssh/authorized_keys
```

**Teste immédiatement** dans un nouveau PowerShell, **sans fermer la session root** :

```powershell
ssh streamloader@<IP_DU_VPS>
```

Tu dois te connecter **sans mot de passe**. Si ça ne marche pas, ne passe pas à l'étape
suivante — recommence 1.4 en gardant la session root ouverte comme filet de sécurité.

### 1.5 Sécuriser SSH (une fois la clé confirmée fonctionnelle)

Toujours en root :

```bash
nano /etc/ssh/sshd_config
```

Trouve (ou ajoute) ces lignes et mets-les à jour :
```
PermitRootLogin no
PasswordAuthentication no
```

Sauvegarde (`Ctrl+O`, Entrée, `Ctrl+X`), puis :

```bash
systemctl restart ssh
```

⚠️ **Ne ferme pas encore la session root.** Ouvre un nouveau PowerShell et vérifie que
`ssh streamloader@<IP_DU_VPS>` fonctionne toujours. Si oui, tu peux fermer la session root —
tu ne te connecteras plus jamais qu'en tant que `streamloader`, avec `sudo` quand nécessaire.

**À partir de maintenant, toutes les commandes suivantes se font connecté en `streamloader`,
avec `sudo` devant les commandes qui en ont besoin.**

### 1.6 Pare-feu de base (SSH uniquement pour l'instant)

```bash
sudo ufw allow OpenSSH
sudo ufw enable
# Tape 'y' pour confirmer
sudo ufw status
```

### 1.7 (Optionnel mais recommandé) fail2ban contre le brute-force SSH

```bash
sudo apt install -y fail2ban
sudo systemctl enable --now fail2ban
```

---

## 2. Installer les dépendances système

```bash
# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # doit afficher v20.x.x

# Python + pip + ffmpeg (nécessaires à yt-dlp et à la conversion audio/vidéo)
sudo apt install -y python3 python3-pip ffmpeg
ffmpeg -version | head -n 1

# yt-dlp
sudo pip3 install --upgrade yt-dlp --break-system-packages
yt-dlp --version

# git (pour récupérer/mettre à jour le code facilement)
sudo apt install -y git

# PM2 — garde l'app en vie, redémarre automatiquement en cas de crash/reboot
sudo npm install -g pm2
pm2 -v
```

---

## 3. Transférer le projet sur le VPS

Ce projet n'est **pas encore** un dépôt git — deux options :

### Option A — Transfert direct depuis Windows (le plus simple, recommandé maintenant)

Depuis **PowerShell sur ta machine Windows** (pas sur le VPS) :

```powershell
scp -r "C:\Users\OTH\Desktop\projet 1\projet final" streamloader@<IP_DU_VPS>:/home/streamloader/streamloader
```

Ça copie tout le dossier (ça peut prendre quelques minutes selon ta connexion — `node_modules`
est gros, tu peux l'exclure et refaire `npm install` sur le VPS à la place, voir remarque
ci-dessous).

💡 Pour aller plus vite, exclut `node_modules` et `tmp` avant transfert (ils seront
régénérés) :
```powershell
robocopy "C:\Users\OTH\Desktop\projet 1\projet final" "$env:TEMP\streamloader-deploy" /E /XD node_modules tmp data
scp -r "$env:TEMP\streamloader-deploy" streamloader@<IP_DU_VPS>:/home/streamloader/streamloader
```

### Option B — Via un dépôt git (GitHub/GitLab)

Si tu préfères passer par git pour faciliter les mises à jour futures : initialise un dépôt
en local (`git init`, `git add .`, `git commit`), pousse-le sur GitHub, puis sur le VPS :

```bash
cd /home/streamloader
git clone <URL_DE_TON_DEPOT> streamloader
```

---

## 4. Configurer le fichier `.env` de production

Sur le VPS :

```bash
cd /home/streamloader/streamloader
cp .env.example .env
nano .env
```

Remplis **chaque ligne** comme suit :

| Variable | Valeur à mettre | Pourquoi |
|---|---|---|
| `NODE_ENV` | `production` | Sans ça, le CORS reste permissif (accepte n'importe quelle origine) — faille de sécurité en public |
| `APP_URL` | `https://TON-DOMAINE.com` | Utilisé pour les liens (CGU, webhook de paiement, etc.) |
| `PORT` | `3000` | Port interne — jamais exposé directement à Internet (nginx s'en charge) |
| `JWT_SECRET` | *(génère une nouvelle valeur, voir ci-dessous)* | Signe les sessions utilisateur — ne réutilise JAMAIS celle du développement |
| `DB_PATH` | `./data/streamloader.db` | Chemin de la base SQLite, relatif au dossier du projet |
| `GENIUSPAY_API_KEY` / `GENIUSPAY_API_SECRET` | Tes clés **de production** GeniusPay | Les clés sandbox ne débitent pas de vrai argent |
| `GENIUSPAY_WEBHOOK_SECRET` | Le secret webhook configuré côté GeniusPay | Vérifie que les notifications de paiement viennent bien de GeniusPay |
| `TELEGRAM_BOT_TOKEN` | Un **nouveau** token (voir ci-dessous) | L'ancien a été exposé pendant le développement |
| `TELEGRAM_PREMIUM_IDS` | Laisse vide sauf besoin spécifique | |
| `SHAZAM_API_KEY` / `SHAZAM_API_HOST` | Tes identifiants RapidAPI | Pour le bouton "Musique Officielle" du bot |
| `ADMIN_TOKEN` | Garde la valeur actuelle ou régénère-en une | Protège `/admin-reviews.html` |
| `AD_REDIRECT_URL` | Laisse vide si pas encore de partenaire pub | |

**Générer un `JWT_SECRET` fort :**
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```
Copie le résultat dans `.env`.

**Régénérer le token Telegram :**
1. Ouvre une conversation avec [@BotFather](https://t.me/BotFather) sur Telegram
2. `/mybots` → sélectionne ton bot → `API Token` → `Revoke current token`
3. Copie le nouveau token dans `TELEGRAM_BOT_TOKEN`

Sauvegarde le fichier (`Ctrl+O`, Entrée, `Ctrl+X`).

⚠️ Vérifie qu'**aucune autre instance du bot** ne tourne ailleurs avec ce nouveau token avant
de démarrer (sinon erreur `409 Conflict`, voir partie 13).

---

## 5. Installer les dépendances du projet

```bash
cd /home/streamloader/streamloader
npm install --production
```

Les dossiers `data/` (base SQLite) et `tmp/` (fichiers temporaires de téléchargement) sont
créés automatiquement par l'application au premier démarrage — rien à faire manuellement.

---

## 6. Lancer l'application avec PM2

```bash
pm2 start deploy/ecosystem.config.js
pm2 save
pm2 startup
```

La dernière commande affiche une ligne de commande à copier-coller (elle commence par
`sudo env PATH=...`) — **exécute-la telle quelle**, c'est elle qui fait démarrer PM2
automatiquement au redémarrage du VPS.

Vérifications :
```bash
pm2 status                    # les deux process doivent être "online"
pm2 logs streamloader-web --lines 30
pm2 logs streamloader-bot --lines 30
curl http://localhost:3000/api/health   # doit répondre {"status":"ok"}
```

---

## 6 bis. (Optionnel) Envoyer des fichiers jusqu'à 100 Mo sur Telegram

Par défaut, **Telegram refuse tout fichier de plus de 50 Mo envoyé par un bot**. Ce n'est
pas un réglage de StreamLoader : c'est une limite du service public de Telegram
(`api.telegram.org`), la même pour tous les bots.

Pour la dépasser, Telegram fournit un programme officiel, le **serveur Bot API local**, à
faire tourner sur ton propre VPS. Le bot lui envoie les fichiers, et lui les transmet à
Telegram — avec une limite portée à **2 000 Mo**. Sans cette étape, le bot reste à 50 Mo
(il prévient l'utilisateur et lui donne le lien du site pour les fichiers plus lourds).

### 6 bis.1 Obtenir un `api_id` et un `api_hash`

1. Va sur **https://my.telegram.org** et connecte-toi avec ton numéro de téléphone Telegram.
2. Clique sur **API development tools**.
3. Crée une application (nom et description libres, ex. « StreamLoader »).
4. Note les deux valeurs affichées : **`api_id`** (un nombre) et **`api_hash`** (une suite
   de lettres et chiffres). Garde-les secrètes, comme un mot de passe.

### 6 bis.2 Installer et lancer le serveur Bot API local

Le plus simple est de passer par Docker :

```bash
sudo apt install -y docker.io
sudo systemctl enable --now docker

sudo docker run -d --name telegram-bot-api --restart=always \
  -p 127.0.0.1:8081:8081 \
  -e TELEGRAM_API_ID=TON_API_ID \
  -e TELEGRAM_API_HASH=TON_API_HASH \
  -e TELEGRAM_LOCAL=1 \
  -v telegram-bot-api-data:/var/lib/telegram-bot-api \
  aiogram/telegram-bot-api:latest
```

Remplace `TON_API_ID` et `TON_API_HASH` par tes valeurs. Quelques explications :
- `127.0.0.1:8081` : le serveur n'écoute que sur le VPS lui-même, il n'est pas accessible
  depuis Internet (ne pas ouvrir ce port dans le pare-feu).
- `TELEGRAM_LOCAL=1` : c'est ce mode « local » qui autorise les fichiers jusqu'à 2 000 Mo.
- `--restart=always` : le serveur redémarre tout seul avec le VPS.

Vérifie qu'il tourne :
```bash
sudo docker ps                 # la ligne "telegram-bot-api" doit être "Up"
sudo docker logs telegram-bot-api --tail 20
```

> L'image `aiogram/telegram-bot-api` est une version prête à l'emploi du programme officiel
> de Telegram (code source : https://github.com/tdlib/telegram-bot-api). Si tu préfères, tu
> peux compiler toi-même ce programme officiel en suivant les instructions de ce dépôt.

### 6 bis.3 Détacher le bot du service public de Telegram

Un bot ne peut être relié qu'à un seul serveur à la fois. Arrête-le, puis « déconnecte-le »
du service public (à faire **une seule fois**) :

```bash
pm2 stop streamloader-bot
curl "https://api.telegram.org/botTON_TOKEN_TELEGRAM/logOut"
# Réponse attendue : {"ok":true,"result":true}
```

Remplace `TON_TOKEN_TELEGRAM` par la valeur de `TELEGRAM_BOT_TOKEN` (garde bien le mot
`bot` collé juste avant). Après ce `logOut`, le bot ne peut plus revenir sur le service
public pendant 10 minutes : c'est normal.

### 6 bis.4 Indiquer au bot d'utiliser le serveur local

```bash
nano ~/streamloader/.env
```

Renseigne ces deux lignes (elles existent déjà, vides) :
```
TELEGRAM_API_URL=http://127.0.0.1:8081
TELEGRAM_MAX_FILE_MB=100
```

Puis relance le bot et vérifie :
```bash
pm2 restart streamloader-bot --update-env
pm2 logs streamloader-bot --lines 10
# Tu dois voir : [bot] Envoi via http://127.0.0.1:8081 — fichiers jusqu'à 100 Mo.
```

`TELEGRAM_MAX_FILE_MB` peut monter jusqu'à 2000, mais plus les fichiers sont gros, plus
ils occupent le disque, la bande passante et le temps d'envoi du VPS : 100 est un bon
compromis.

**Pour revenir en arrière** : vide `TELEGRAM_API_URL` dans `.env`, exécute
`curl "http://127.0.0.1:8081/botTON_TOKEN_TELEGRAM/logOut"`, attends 10 minutes, puis
`pm2 restart streamloader-bot --update-env`. Le bot repasse alors à 50 Mo.

---

## 7. Nom de domaine (DNS)

Chez ton registrar (Namecheap, OVH, Google Domains…), dans la gestion DNS de ton domaine,
ajoute :

| Type | Hôte | Valeur | TTL |
|---|---|---|---|
| A | `@` | `<IP_DU_VPS>` | Auto (ou 3600) |
| A | `www` | `<IP_DU_VPS>` | Auto (ou 3600) |

La propagation prend de quelques minutes à 24h. Vérifie depuis ta machine Windows :
```powershell
nslookup TON-DOMAINE.com
```
Quand ça renvoie bien l'IP de ton VPS, passe à la suite.

---

## 8. Reverse proxy nginx

```bash
sudo apt install -y nginx

cd /home/streamloader/streamloader
sudo cp deploy/nginx-streamloader.conf /etc/nginx/sites-available/streamloader
sudo nano /etc/nginx/sites-available/streamloader
```

Remplace les deux occurrences de `TON-DOMAINE.com` par ton vrai domaine, sauvegarde, puis :

```bash
sudo ln -s /etc/nginx/sites-available/streamloader /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default   # retire le site par défaut nginx
sudo nginx -t                                  # doit afficher "syntax is ok" / "test is successful"
sudo systemctl reload nginx
```

Teste dans ton navigateur : `http://TON-DOMAINE.com` doit maintenant afficher le site (en
HTTP pour l'instant, le HTTPS arrive à l'étape suivante).

---

## 9. HTTPS avec Let's Encrypt (certbot)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d TON-DOMAINE.com -d www.TON-DOMAINE.com
```

Certbot te demande un email (pour les alertes d'expiration) et si tu veux rediriger
automatiquement le HTTP vers le HTTPS — **réponds oui**. Il réécrit lui-même la config
nginx pour ajouter le certificat.

Le renouvellement est automatique (le certificat expire tous les 90 jours). Vérifie que le
timer est actif :
```bash
sudo systemctl status certbot.timer
sudo certbot renew --dry-run   # simule un renouvellement sans le faire réellement
```

---

## 10. Pare-feu final

```bash
sudo ufw allow 'Nginx Full'   # ouvre 80 + 443
sudo ufw status
```

**Le port 3000 ne doit JAMAIS apparaître comme ouvert publiquement** (`ufw status` ne doit
pas le lister) — seul nginx (443/80) doit être exposé, il redirige en interne vers
`localhost:3000`.

---

## 11. Checklist de vérification complète

- [ ] `https://TON-DOMAINE.com/api/health` répond `{"status":"ok"}` avec un cadenas valide
- [ ] `http://TON-DOMAINE.com` redirige automatiquement vers `https://`
- [ ] La page d'accueil s'affiche correctement, sans erreur dans la console navigateur (F12)
- [ ] Création de compte + connexion fonctionnent
- [ ] Analyse d'une URL (ex. YouTube) fonctionne et affiche les formats
- [ ] Un téléchargement complet aboutit (vérifie que `yt-dlp` est dans le PATH de
      l'utilisateur `streamloader` : `which yt-dlp`)
- [ ] Le bot Telegram répond à `/start`, `/help`, `/legal`
- [ ] Un paiement Premium réel (petit montant) passe correctement via GeniusPay et active
      bien le compte
- [ ] Génération d'une clé API Premium fonctionne, et un appel `curl` avec cette clé sur
      `/api/v1/analyze` répond correctement
- [ ] `/admin-reviews.html` demande bien le jeton admin et refuse l'accès sans lui
- [ ] Mentions légales / confidentialité à jour avec le vrai nom et la vraie adresse de ton
      hébergeur VPS (remplace les `[À COMPLÉTER]` restants dans `public/mentions-legales.html`
      et `public/confidentialite.html`)

---

## 12. Maintenance

### Mettre à jour le code

**Si tu as transféré via SCP (Option A)** — retransfère les fichiers modifiés puis :
```bash
pm2 restart all
```

**Si tu utilises git (Option B)** :
```bash
cd /home/streamloader/streamloader
git pull
npm install --production
pm2 restart all
```

### Sauvegarder la base de données

Aucune sauvegarde automatique n'existe par défaut. Ajoute une tâche planifiée :
```bash
sudo mkdir -p /var/backups/streamloader
crontab -e
```
Ajoute cette ligne (sauvegarde quotidienne à 3h du matin) :
```
0 3 * * * cp /home/streamloader/streamloader/data/streamloader.db /var/backups/streamloader/streamloader-$(date +\%F).db
```

### Mettre à jour yt-dlp manuellement

L'app le fait déjà automatiquement toutes les 24h au démarrage, mais en cas de besoin
immédiat :
```bash
sudo pip3 install --upgrade yt-dlp --break-system-packages
pm2 restart streamloader-web
```

### Consulter les logs

```bash
pm2 logs                          # les deux apps en direct
pm2 logs streamloader-web --lines 100
sudo tail -f /var/log/nginx/error.log
```

### Rotation des secrets

Si tu soupçonnes qu'un secret a fuité (`.env` visible quelque part, capture d'écran
partagée…) : régénère-le (voir partie 4), redémarre avec `pm2 restart all`, et pour le
token Telegram pense à `/revoke` sur BotFather d'abord.

---

## 13. Dépannage courant

**`pm2 status` montre "errored" ou l'app redémarre en boucle**
→ `pm2 logs streamloader-web --lines 50` pour voir l'erreur exacte. Cause fréquente :
`.env` mal rempli ou `JWT_SECRET` absent (l'app refuse de démarrer sans lui).

**Le bot Telegram ne répond pas / erreur `409 Conflict` dans les logs**
→ Une autre instance tourne déjà ailleurs avec le même token. Vérifie sur toute autre
machine/serveur où tu aurais pu laisser tourner `bot.js`, arrête-la, ou régénère un nouveau
token via BotFather comme indiqué en partie 4.

**`yt-dlp: command not found` dans les logs de téléchargement**
→ `yt-dlp` n'est pas dans le PATH de l'utilisateur `streamloader`. Vérifie avec
`which yt-dlp` connecté en tant que `streamloader` (pas root) ; si absent, réinstalle avec
`sudo pip3 install --upgrade yt-dlp --break-system-packages`.

**`certbot --nginx` échoue avec une erreur de validation**
→ Le DNS n'a pas encore propagé (voir partie 7) ou le port 80 n'est pas ouvert
(`sudo ufw allow 'Nginx Full'`). Réessaie après `nslookup` confirmant la bonne IP.

**Le site charge mais les paiements ne débitent rien**
→ Tu es probablement encore sur les clés `sk_sandbox_...` / `ss_sandbox_...` de GeniusPay
au lieu des clés de production (partie 4).

**502 Bad Gateway dans le navigateur**
→ L'app Node ne tourne pas ou a crashé. `pm2 status` puis `pm2 logs` pour diagnostiquer,
`pm2 restart streamloader-web` pour relancer.
