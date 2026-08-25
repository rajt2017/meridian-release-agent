# Meridian Release Agent
> A release governance agent built with the Cursor TypeScript SDK

## What it does
Catches drift between backend, API spec, SDK, and runbooks before 
a quarterly release ships to customers. Classifies every change as 
additive, breaking, or ambiguous — then produces a go/no-go report. 
A human always makes the final call.

## The pipeline
Watcher → Judge → Cross-Checker → Reporter → Human sign-off

## How to run
source ~/.nvm/nvm.sh
export CURSOR_API_KEY=$(grep CURSOR_API_KEY .env | cut -d '=' -f2)
npm start

Then open release-report.html in your browser.

## Built with
Cursor TypeScript SDK — Example C (Runbook & API Spec Sync)
