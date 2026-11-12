#!/bin/bash
#
# Script de release pour le plugin WordPress GeniusPay
# Publie sur WordPress.org SVN
# Usage: ./scripts/release-wordpress.sh 1.0.0
#

set -e

VERSION=$1
PLUGIN_SLUG="geniuspay-woocommerce"
SVN_URL="https://plugins.svn.wordpress.org/${PLUGIN_SLUG}/"
PLUGIN_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# Couleurs
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

if [ -z "$VERSION" ]; then
    echo -e "${RED}❌ Usage: ./scripts/release-wordpress.sh 1.0.0${NC}"
    exit 1
fi

# Valider le format de version
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo -e "${RED}❌ Format de version invalide. Utilisez X.Y.Z${NC}"
    exit 1
fi

echo -e "${CYAN}"
echo "╔════════════════════════════════════════════════════════════╗"
echo "║     🚀 Release WordPress Plugin v$VERSION                   ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Vérifier que la version dans le fichier principal correspond
MAIN_VERSION=$(grep -m1 "Version:" "${PLUGIN_DIR}/geniuspay-woocommerce.php" | sed 's/.*Version: //' | tr -d '[:space:]')
if [ "$MAIN_VERSION" != "$VERSION" ]; then
    echo -e "${RED}❌ La version dans geniuspay-woocommerce.php ($MAIN_VERSION) ne correspond pas à $VERSION${NC}"
    echo -e "${YELLOW}Mettez à jour la version dans le fichier principal puis relancez le script${NC}"
    exit 1
fi

# Vérifier que la version dans readme.txt correspond
README_VERSION=$(grep -m1 "Stable tag:" "${PLUGIN_DIR}/readme.txt" 2>/dev/null | sed 's/.*Stable tag: //' | tr -d '[:space:]')
if [ "$README_VERSION" != "$VERSION" ]; then
    echo -e "${RED}❌ La version dans readme.txt ($README_VERSION) ne correspond pas à $VERSION${NC}"
    echo -e "${YELLOW}Mettez à jour 'Stable tag' dans readme.txt puis relancez le script${NC}"
    exit 1
fi

# Créer un dossier temporaire
TEMP_DIR=$(mktemp -d)
echo -e "${YELLOW}📁 Dossier temporaire: $TEMP_DIR${NC}"

# Checkout SVN
echo -e "${YELLOW}⬇️  Checkout du repository SVN...${NC}"
svn checkout "$SVN_URL" "$TEMP_DIR" --depth immediates
svn update --set-depth infinity "$TEMP_DIR/trunk"
svn update --set-depth immediates "$TEMP_DIR/tags"

# Vérifier si le tag existe déjà
if [ -d "$TEMP_DIR/tags/$VERSION" ]; then
    echo -e "${RED}❌ Le tag $VERSION existe déjà sur WordPress.org${NC}"
    rm -rf "$TEMP_DIR"
    exit 1
fi

# Fichiers à exclure de la release
EXCLUDES=(
    ".git"
    ".github"
    ".gitignore"
    ".gitattributes"
    "node_modules"
    "scripts"
    "tests"
    "phpunit.xml"
    "composer.json"
    "composer.lock"
    "package.json"
    "package-lock.json"
    ".editorconfig"
    ".phpcs.xml"
    "README.md"
)

# Construire la commande rsync avec les exclusions
RSYNC_EXCLUDES=""
for EXCLUDE in "${EXCLUDES[@]}"; do
    RSYNC_EXCLUDES="$RSYNC_EXCLUDES --exclude=$EXCLUDE"
done

# Copier les fichiers vers trunk
echo -e "${YELLOW}📋 Copie des fichiers vers trunk...${NC}"
rsync -av $RSYNC_EXCLUDES "${PLUGIN_DIR}/" "$TEMP_DIR/trunk/"

# Ajouter les nouveaux fichiers à SVN
echo -e "${YELLOW}➕ Ajout des nouveaux fichiers...${NC}"
cd "$TEMP_DIR"
svn status trunk | grep '^\?' | awk '{print $2}' | xargs -I {} svn add {}

# Supprimer les fichiers manquants de SVN
svn status trunk | grep '^\!' | awk '{print $2}' | xargs -I {} svn delete {}

# Créer le tag
echo -e "${YELLOW}🏷️  Création du tag $VERSION...${NC}"
svn cp trunk "tags/$VERSION"

# Afficher les changements
echo -e "${CYAN}📝 Changements à commiter:${NC}"
svn status

# Confirmation
echo ""
read -p "Voulez-vous commiter ces changements ? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Release annulée${NC}"
    rm -rf "$TEMP_DIR"
    exit 0
fi

# Commit
echo -e "${YELLOW}⬆️  Commit vers WordPress.org SVN...${NC}"
svn ci -m "Release version $VERSION"

# Nettoyage
rm -rf "$TEMP_DIR"

echo ""
echo -e "${GREEN}✅ Version $VERSION publiée sur WordPress.org !${NC}"
echo ""
echo "📋 Prochaines étapes :"
echo "   1. Vérifier sur https://wordpress.org/plugins/${PLUGIN_SLUG}/"
echo "   2. La mise à jour peut prendre quelques minutes"
echo "   3. Annoncer la release sur les canaux appropriés"
echo ""
