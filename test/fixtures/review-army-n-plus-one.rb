# N+1 query example — intentionally bad for testing
class PostsController
  def index
    @posts = Post.all
    @posts.each do |post|
      # N+1: queries Author table for every post
      puts post.author.name
      # N+1: queries Comments table for every post
      puts post.comments.count
    end
  end
end
