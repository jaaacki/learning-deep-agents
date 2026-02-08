#!/bin/bash

# Copy deepagents project to ~/Dev/deepagents
echo "📦 Copying Deep Agents project to ~/Dev/deepagents..."

# Create target directory
mkdir -p ~/Dev/deepagents

# Copy all files
cp -r /tmp/deepagents-test/* ~/Dev/deepagents/

echo "✅ Done! Now run:"
echo ""
echo "   cd ~/Dev/deepagents"
echo "   pnpm install"
echo "   cp config.json.example config.json"
echo "   # Edit config.json with your credentials"
echo "   pnpm start"
echo ""