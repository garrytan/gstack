class UserController < ApplicationController
  def show
    # SQL injection — interpolating user input directly into query
    @user = User.where("id = #{params[:id]}").first
    render json: @user
  end

  def promote
    # Bypasses ActiveRecord validations — update_column skips callbacks + validation
    @user = User.find(params[:id])
    @user.update_column(:role, 'admin')
    head :ok
  end
end
