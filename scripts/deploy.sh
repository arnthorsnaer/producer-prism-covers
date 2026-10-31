#!/bin/sh
# Builds the app and publishes dist/ to the gh-pages branch, which GitHub
# Pages serves at https://arnthorsnaer.github.io/producer-prism-covers/.
set -e
npm run build
touch dist/.nojekyll
tmp=$(mktemp -d)
cp -R dist/. "$tmp"
cd "$tmp"
git init -q -b gh-pages
git add -A
git commit -q -m "Publish built site"
git push -q -f https://github.com/arnthorsnaer/producer-prism-covers.git gh-pages
rm -rf "$tmp"
echo "Published. Live in about a minute."
