#!/bin/bash
set -e
npm ci
npx playwright install chromium
