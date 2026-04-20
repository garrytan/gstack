# ActiveJob notifier fixture — shape-detection-only in v1.
# /qa-headless should detect this as a 'notifier' (or 'queue worker') and route to manual guidance.

require 'net/http'
require 'json'

class DigestNotifierJob < ApplicationJob
  queue_as :default

  def perform(user_id, message)
    payload = {
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: "User #{user_id}" } },
        { type: 'section', text: { type: 'mrkdwn', text: message } }
      ]
    }
    uri = URI(ENV.fetch('SLACK_WEBHOOK_URL'))
    Net::HTTP.post(uri, payload.to_json, 'Content-Type' => 'application/json')
  end
end
