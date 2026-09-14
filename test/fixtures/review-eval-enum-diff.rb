# Feature branch version: adds "returned" status but misses consumers
class Order < ApplicationRecord
  STATUSES = %w[pending processing shipped delivered returned].freeze

  validates :status, inclusion: { in: STATUSES }

  def display_status
    case status
    when 'pending'    then 'Awaiting processing'
    when 'processing' then 'Being prepared'
    when 'shipped'    then 'On the way'
    when 'delivered'  then 'Delivered'
    # BUG: 'returned' not handled — falls through to nil
    end
  end

  def can_cancel?
    # BUG: should 'returned' be cancellable? Not considered.
    %w[pending processing].include?(status)
  end

  def notify_customer
    case status
    when 'pending'    then OrderMailer.confirmation(self).deliver_later
    when 'shipped'    then OrderMailer.shipped(self).deliver_later
    when 'delivered'  then OrderMailer.delivered(self).deliver_later
    # BUG: 'returned' has no notification — customer won't know return was received
    end
  end
end
