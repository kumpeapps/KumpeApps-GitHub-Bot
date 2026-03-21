---
description: "Generate a .gitleaks.toml configuration file for KumpeApps-GitHub-Bot to fix secret scanner false positives"
---

Generate a `.gitleaks.toml` configuration file for the KumpeApps-GitHub-Bot secret scanner.

**CRITICAL**: All patterns must be **lowercase** because the bot normalizes strings before matching.

Ask the user:
1. What files are triggering false positives? (e.g., README.md:674)
2. What content is being flagged? (e.g., environment variable examples, documentation)
3. Should the entire file be excluded from scanning?

Then generate:

```toml
# .gitleaks.toml
# Configuration for KumpeApps-GitHub-Bot local secret scanner
# IMPORTANT: All patterns are lowercase (bot normalizes before matching)

title = "{Repository Name}"

[allowlist]
  description = "Allowlist for false positives"
  
  # Files to completely skip scanning (normalized paths)
  paths = [
    '''readme\.md$''',
    '''\.gitleaks\.toml$''',
    '''\.gitleaksignore$''',
    # Add more files here
  ]
  
  # String fragments to ignore (normalized values)
  stopwords = [
    # Add lowercase stopwords here
  ]
  
  # Patterns to ignore in content (normalized text)
  regexes = [
    # Add lowercase regex patterns here
  ]

# Optional: Additional rules for specific detectors
# [[rules]]
#   description = "Example rule"
#   id = "rule-id"
#   [rules.allowlist]
#     paths = ['''specific-file\.md$''']
```

Include:
- Comments explaining normalization
- Specific patterns for the user's false positives (in lowercase)
- Instructions to save as `.gitleaks.toml` (with leading dot)
