# KumpeApps-GitHub-Bot Repository Integration

This template provides GitHub Copilot customizations for repositories that use the KumpeApps-GitHub-Bot.

## What This Provides

### 🤖 Bot Config Helper Agent
**File**: `.github/agents/bot-config-helper.agent.md`

A specialized Copilot agent that understands:
- How the bot normalizes paths and strings to lowercase
- Correct file naming (`.gitleaks.toml` with leading dot)
- Gitleaks configuration structure
- Bot policy configuration (`.github/kumpeapps-bot.yml`)
- **Commit message formatting** requirements (`[branch_name] Message`)

### ⚡ Gitleaks Config Generator Prompt
**File**: `.github/prompts/generate-gitleaks-config.prompt.md`

A quick prompt to generate properly formatted `.gitleaks.toml` files with lowercase patterns.

## Installation

### Option 1: Direct Copy
Copy the `.github/` directory from this template into your repository:

```bash
cp -r .github/ /path/to/your/repo/.github/
cd /path/to/your/repo
git add .github/
git commit -m "Add KumpeApps-GitHub-Bot Copilot customizations"
```

### Option 2: Download from GitHub
From your repository root:

```bash
# Create directories
mkdir -p .github/agents .github/prompts

# Download agent
curl -sL https://raw.githubusercontent.com/kumpeapps/KumpeApps-GitHub-Bot/main/.github/templates/repository-setup/.github/agents/bot-config-helper.agent.md \
  -o .github/agents/bot-config-helper.agent.md

# Download prompt (if desired)
curl -sL https://raw.githubusercontent.com/kumpeapps/KumpeApps-GitHub-Bot/main/.github/templates/repository-setup/.github/generate-gitleaks-config.prompt.md \
  -o .github/prompts/generate-gitleaks-config.prompt.md

# Commit
git add .github/
git commit -m "Add bot-config-helper Copilot agent"
```

### Option 3: Manual Install
1. Create `.github/agents/` directory in your repository
2. Copy `bot-config-helper.agent.md` into that directory
3. Optionally copy the prompt file to `.github/prompts/`
4. Commit the files

## Usage

Once installed, developers using GitHub Copilot in your repository can:

### Use the Agent Directly
```
@bot-config-helper fix the README.md:674 false positive
@bot-config-helper help me format my commit message
@bot-config-helper create a gitleaks config for this repo
```

### Let Copilot Auto-Delegate
```
User: "The bot is reporting a false positive for my environment variables"
Copilot: [May automatically use @bot-config-helper based on the description]
```

### Use the Prompt
```
/generate-gitleaks-config
```

## How It Works

GitHub Copilot automatically discovers `.agent.md` and `.prompt.md` files in the `.github/` directory and makes them available:

- **Agents** appear in the `@` agent selector and can be invoked by other agents
- **Prompts** appear when you type `/` in Copilot chat
- These are **workspace-specific** - they only apply to this repository

## Example Workflow

1. Developer sees bot error: "Local secret scanner found 1 potential secret(s). Example(s): README.md:674"
2. Developer asks Copilot: "Fix this false positive"
3. Copilot (via bot-config-helper agent):
   - Reads the flagged line
   - Creates `.gitleaks.toml` with lowercase patterns
   - Explains the normalization behavior
   - Provides commit commands **with proper branch prefix**

**Commit Message Help:**
```
Developer: "@bot-config-helper help me commit this change"
Agent: 
  # First, get your current branch
  git branch --show-current
  # Output: feature/#23
  
  # Then commit with proper format
  git commit -m "[feature/#23] Add gitleaks configuration for false positives"
  
  # The [feature/#23] prefix is required by the bot
  # The # creates a clickable link to issue #23
```

## Customization

You can edit these files to:
- Add repository-specific patterns or examples
- Include links to your internal documentation
- Adjust the agent's behavior or constraints

## Requirements

- GitHub Copilot enabled in VS Code
- `.agent.md` and `.prompt.md` file support (available in recent Copilot versions)

## Learn More

- [GitHub Copilot Agent Customization](https://code.visualstudio.com/docs/copilot/customization)
- [KumpeApps-GitHub-Bot Documentation](https://github.com/kumpeapps/KumpeApps-GitHub-Bot)
- [Gitleaks Configuration](https://github.com/gitleaks/gitleaks)
