# StreamLoader pour Windows (réservé aux abonnés Premium)

Application PC de StreamLoader. Elle se connecte au **même serveur que le site** :
l'utilisateur se connecte avec son e-mail et son mot de passe du site, l'application
vérifie auprès du serveur (`/api/auth/me`) que le compte est **Premium et non expiré**,
puis pilote les téléchargements (`/api/analyze`, `/api/download/start`,
`/api/progress/:id`, `/api/file/:id`) et enregistre le fichier sur le PC.

Aucune modification du serveur n'est nécessaire.

## Avant de construire : l'adresse du serveur
Ouvre `config.json` et mets l'adresse publique de ton site :
```json
{ "serverUrl": "https://ton-domaine.com", "siteUrl": "https://ton-domaine.com", "premiumPath": "/#pricing" }
```
(Pour tester avec le serveur lancé sur ton PC : `"serverUrl": "http://localhost:3000"`.
On peut aussi la changer dans l'app : Paramètres → Serveur.)

## Lancer en test
Dans ce dossier, avec l'invite de commandes (cmd) :
```
npm.cmd install
npm.cmd start
```

## Construire l'installeur .exe
```
npm.cmd run dist
```
L'installeur est créé dans `dist\StreamLoader-Setup-1.0.0.exe`.
C'est ce fichier à proposer au téléchargement sur le site, réservé aux Premium.

## Fonctionnement
- Connexion avec le compte du site ; jeton chiffré par Windows (safeStorage).
- Compte gratuit → écran « Ton compte n'est pas Premium » avec lien vers l'offre.
- Le plan est revérifié toutes les 20 min : si le Premium expire, l'app se verrouille.
- Formats : MP3, MP4 360p → 4K. Playlists. Glisser-déposer, CTRL + V.
- Téléchargements automatiques (liens vidéo copiés), téléchargements simultanés,
  notifications, mode jour/nuit, français/anglais.
- Historique et réglages dans `%APPDATA%\StreamLoader`.
