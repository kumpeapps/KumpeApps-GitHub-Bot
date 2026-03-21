# GitHub Copilot Agent Customizations

This directory contains templates and customizations to help repositories integrate with and configure the KumpeApps-GitHub-Bot.

## For Repository Owners

If your repository uses KumpeApps-GitHub-Bot, you can add these Copilot customizations to help developers configure gitleaks and bot policies correctly.

### Quick Setup

Copy the template files to your repository:

```bash
# From your repository root
curl -sL https://raw.githubusercontent.com/kumpeapps/KumpeApps-GitHub-Bot/main/.github/templates/repository-setup/.github/agents/bot-config-helper.agent.md \
  -o .github/agents/bot-config-helper.agent.md

mkdir -p .github/prompts
curl -sL https://raw.githubusercontent.com/kumpeapps/KumpeApps-GitHub-Bot/main/.github/templates/repository-setup/.github/generate-gitleaks-config.prompt.md \
  -o .github/prompts/generate-gitleaks-config.prompt.md
```

Or manually copy the files from [`.github/templates/repository-setup/`](./templates/repository-setup/).

Then commit these files to your repository. GitHub Copilot will automatically discover and use them.

## Available Customizations

**Note**: All customization files are maintained in `.github/templates/repository-setup/` as the single source of truth. These templates are deployed to target repositories either automatically (via bot automation) or manually by repository owners.

### 🤖 Bot Config Helper Agent
**Template**: `.github/templates/repository-setup/.github/agents/bot-config-helper.agent.md`

**Use it when**:
- Configuring gitleaks files (`.gitleaks.toml`, `.gitleaksignore`)
- Fixing secret scanner false positives
- Setting up `kumpeapps-bot.yml` policy files
- Understanding bot normalization behavior

**How to use**:
1. In Copilot chat, click the agent selector (@ icon)
2. Type `@bot-config-helper` or select "bot-config-helper" from the list
3. Describe your issue: "Fix the README.md:674 false positive"

Or let the main Copilot agent automatically delegate to it when you mention bot configuration tasks.

### ⚡ Prompt: Generate Gitleaks Config
**Template**: `.github/templates/repository-setup/.github/generate-gitleaks-config.prompt.md`

**Use it when**: You need a quick `.gitleaks.toml` template

**How to use**:
1. In Copilot chat, type `/` to see available commands
2. Type `/generate-gitleaks-config`
3. Answer the questions about your false positives
4. Get a ready-to-use configuration file

### 📝 Workspace Instructions
**File**: `copilot-instructions.md`

Always-on context that helps Copilot understand:
- Bot's lowercase normalization behavior
- File naming requirements (`.gitleaks.toml` vs `gitleaks.toml`)
- Code structure and key functions
- Common pitfalls when configuring the bot

## Working with Other Repositories

When using Copilot in **repositories that use KumpeApps-GitHub-Bot**, these customizations work together with GitHub Copilot's built-in agents:

1. **Copilot Chat** - Ask about secret scanning errors
2. **Auto-delegation** - If Copilot detects you need bot config help, it may suggest using the `bot-config-helper` agent
3. **Manual selection** - Use `@bot-config-helper` explicitly when working on gitleaks configs

## Example Workflows

### Fixing a False Positive
```
You: "The bot is flagging README.md:674 as a high entropy token"

Copilot: [May auto-delegate to bot-config-helper or you can manually select it]

@bot-config-helper: Let me check that file and create the appropriate
gitleaks configuration...
```

### Creating Bot Policy
```
You: @bot-config-helper help me create a kumpeapps-bot.yml file

@bot-config-helper: I'll help you configure the bot policy. Let me
show you the schema and common options...
```

### Quick Config Generation
```
You: /generate-gitleaks-config

Copilot: What files are triggering false positives?

You: README.md and docs/config-example.md

Copilot: [Generates .gitleaks.toml with lowercase patterns]
```

## Key Concepts

### Normalization
The bot converts all paths and strings to **lowercase** before matching:
- Pattern: `'''readme\.md$'''` ✅
- Pattern: `'''README\.md$'''` ❌
- Stopword: `"api_key"` ✅
- Stopword: `"API_KEY"` ❌

### File Naming
Files **must** have leading dots:
- `.gitleaks.toml` ✅
- `gitleaks.toml` ❌
- `.gitleaksignore` ✅
- `gitleaksignore` ❌

### Configuration Priority
1. **Paths allowlist** - Skips entire files (fastest)
2. **Stopwords** - Ignores specific string fragments
3. **Regexes** - Pattern-based filtering
4. **Rules** - Detector-specific overrides

## Contributing

When adding new customizations:
1. Follow the file naming conventions
2. Include clear `description` fields (used for agent discovery)
3. Document the normalization requirement
4. Test with actual bot behavior

## References

- [VS Code Agent Customization Docs](https://code.visualstudio.com/docs/copilot/customization)
- [GitHub Copilot Custom Agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents)
- [KumpeApps-GitHub-Bot Source](../src/index.js)
