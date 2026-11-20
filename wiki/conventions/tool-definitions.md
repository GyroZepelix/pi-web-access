# Tool definitions

Rules for changing the names, descriptions, or parameters of the public Pi tools (`web_search`, `source_check`, `fetch_content`, `get_search_content`).

## Size budget and compatibility hashes

- **Keep the 4400-character default tool-definition budget in `test/tool-definition-size.test.mjs` unchanged** - when a change such as adding a provider to a parameter description pushes the total over, shorten the wording instead of raising the budget. (User decision D6 in item 261120-1135-add-anthropic-web-search-provider)
- **Any change to a public tool's name, description, or parameters changes its compatibility hash in `test/tool-registration-config.test.mjs`** - this includes provider lists built into descriptions, such as the web_search `model` description built from the allowed model providers. Update the expected hash deliberately in the same change, along with any exact-description expectation in that file. (Item 261120-1135-add-anthropic-web-search-provider)
