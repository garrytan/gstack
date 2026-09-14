# Existing file on main: order model with status handling
class Order < ApplicationRecord
  STATUSES = %w[pending processing shipped delivered].freeze

  validates :status, inclusion: { in: STATUSES }

  def display_status
    case status
    when 'pending'    then 'Awaiting processing'
    when 'processing' then 'Being prepared'
    when 'shipped'    then 'On the way'
    when 'delivered'  then 'Delivered'
    end
  end

  def can_cancel?
    %w[pending processing].include?(status)
  end

  def notify_customer
    case status
    when 'pending'    then OrderMailer.confirmation(self).deliver_later
    when 'shipped'    then OrderMailer.shipped(self).deliver_later
    when 'delivered'  then OrderMailer.delivered(self).deliver_later
    end
  end
end
