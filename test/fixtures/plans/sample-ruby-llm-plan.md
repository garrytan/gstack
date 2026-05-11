# CEO Plan: Implement ruby_llm integration
**Branch:** add-ruby-llm | **Date:** 2026-04-01 | **Author:** example

## Phase 0: Foundation

Add the ruby_llm gem and configure the client. Create an initializer that loads the
API key from the environment and sets the default model.

**Files:**
- `config/initializers/ruby_llm.rb` — new initializer
- `app/services/llm_service.rb` — new service wrapping the client

**Success criteria:**
- [x] ruby_llm gem added to Gemfile and installed successfully
- [x] config/initializers/ruby_llm.rb created with API key config
- [ ] LlmService exposes a `complete(prompt)` method
- [ ] LlmService handles API errors and returns a structured result

## Phase 1: First Feature

Build a summarization endpoint backed by ruby_llm. Add a model and controller to
store requests and return streamed responses.

**Files:**
- `app/models/summary_request.rb` — new model
- `app/controllers/summaries_controller.rb` — new controller

**Gem:**
- `ruby_llm` (already added in Phase 0)

**Success criteria:**
- app/models/summary_request.rb exists with validations
- POST /summaries creates a SummaryRequest and enqueues a job
