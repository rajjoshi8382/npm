#!/bin/bash

echo "🚀 Starting build process..."

# Step 1: Build the React frontend
cd frontend
echo "📦 Installing frontend dependencies..."
npm install

echo "⚙️  Building frontend..."
npm run build

# Step 2: Copy the build to backend directory
echo "📁 Copying build to backend..."
cp -r build ../backend/

# Step 3: Install backend dependencies
cd ../backend
echo "📦 Installing backend dependencies..."
npm install

echo "✅ Build process complete!"
