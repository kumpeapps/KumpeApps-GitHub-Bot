# KumpeApps-GitHub-Bot Workspace Instructions

This is the KumpeApps-GitHub-Bot repository - a GitHub App bot that enforces compliance rules, performs secret scanning, and manages pull requests across repositories.

## Working in This Repository

When working in THIS repository, you are:
- **Developing the bot itself** - modifying bot logic, handlers, and features
- **Maintaining templates** - updating Copilot agent templates in `.github/templates/repository-setup/` that other repositories can use

## Templates for Other Repositories

The `.github/templates/repository-setup/` directory contains Copilot agent customizations that repository owners can copy to their own repos. These help developers in THOSE repositories configure gitleaks and bot policies correctly.

When updating templates:
- Keep them general-purpose and applicable to any repository using the bot
- Document the bot's normalization behavior (lowercase conversion)
- Include examples and common patterns

## Key Bot Behaviors

### Secret Scanning
The bot performs **local secret scanning** on pull requests by:
1. Fetching changed files from PRs
2. Scanning for high-entropy strings and known secret patterns
3. Checking against `.gitleaks.toml` and `.gitleaksignore` configuration
4. **Important**: All paths and string values are **normalized to lowercase** before pattern matching

Configuration files (must use these exact names):
- `.gitleaksignore` - Contains gitleaks fingerprints for baseline ignoring
- `.gitleaks.toml` - Contains allowlist patterns (paths, stopwords, regexes)

### Pattern Normalization
ALL string comparisons are normalized via this function:
```javascript
function normalizeType(value) {
  return String(value || "").trim().toLowerCase();
}
```

This means:
- `README.md` becomes `readme.md` before path matching
- `SITES_DIR` becomes `sites_dir` before stopword matching
- All regex patterns must use lowercase to match

### Configuration Files
- `.github/kumpeapps-bot.yml` - Per-repository bot policy configuration
- Controls compliance rules, security scanning, PR requirements

## Development Notes

### Technology Stack
- Node.js application
- GitHub Probot framework
- TOML parsing for gitleaks configuration
- Docker deployment

### Testing Secret Scanning
When debugging gitleaks configuration:
1. Ensure filenames are exact: `.gitleaks.toml` (with dot), not `gitleaks.toml`
2. Ensure all patterns are lowercase
3. Check that normalized paths match patterns (e.g., `readme.md`, not `README.md`)
4. Test regex patterns against normalized strings

### Code Location
- `src/index.js` - Main bot logic
- Constants starting at line 75-89 define secret scanner configuration
- `parseGitleaksTomlConfig()` at line 2175 handles config parsing
- `shouldIgnoreSecretCandidate()` at line 2499 applies allowlist rules
- `normalizeType()` at line 1025 performs lowercase normalization

## When Working on Bot Features

Always consider:
- String/path normalization impact
- Case sensitivity in configurations
- Gitleaks config compatibility with JavaScript RegExp
- File naming requirements (leading dots, exact names)
