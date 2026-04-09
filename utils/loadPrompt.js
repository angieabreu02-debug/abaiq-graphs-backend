const fs = require('fs');
const path = require('path');

const promptCache = {};

function loadPrompt(fileName) {
  if (promptCache[fileName]) {
    return promptCache[fileName];
  }
  const promptPath = path.join(__dirname, '../prompts', fileName);
  try {
    const content = fs.readFileSync(promptPath, 'utf8');
    promptCache[fileName] = content;
    return content;
  } catch (err) {
    throw new Error(`Failed to load system prompt file: ${fileName}. Error: ${err.message}`);
  }
}

function preloadAllPrompts() {
  const promptsDir = path.join(__dirname, '../prompts');
  try {
    const files = fs.readdirSync(promptsDir).filter(f => f.endsWith('.txt'));
    for (const file of files) {
      loadPrompt(file);
    }
    console.log(`[PROMPTS] Pre-loaded ${files.length} prompt files into cache`);
  } catch (err) {
    console.error('[PROMPTS] Failed to pre-load prompts:', err.message);
  }
}

module.exports = { loadPrompt, preloadAllPrompts };
