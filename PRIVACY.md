# Privacy Policy – AI Test Data Filler

_Last updated: [02.10.2026]. Contact: [andris.priede@gmail.com]._

AI Test Data Filler fills web forms with fictional test data written by an AI service you choose and pay for yourself.

## What the extension sends, and when
Only when you click **Fill this page**, the extension sends the following to the AI provider you selected
(Anthropic for Claude, or OpenAI for ChatGPT), using your own API key:
- a description of the fillable form fields on the current page: labels, field names, input types, placeholders,
  allowed options, length and format limits;
- the option currently selected in drop-downs and radio buttons on the page (for example a chosen country), so the generated data can match it;
- the language and instructions you typed into the extension.

It does **not** send values you have typed into the page, passwords, cookies, browsing history, or other page text.
Password, payment card and security-code fields are ignored.

## What is stored
Your API key(s), model names and preferences are stored locally in your browser (`chrome.storage.local`). They are not
synced, not sent to the developer, and are sent only to the provider they belong to.

## What we do not do
No analytics, no tracking, no advertising, no sale or sharing of data, no remote code. The developer receives no data
from your use of the extension.

## Third parties
Requests to Anthropic or OpenAI are governed by their own terms and privacy policies. Use of your API key is billed by that provider.

## Control
Remove your keys on the setup page or uninstall the extension to delete all stored data.
