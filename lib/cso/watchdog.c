/* Independent CSO lease watchdog. It accepts only exact journaled container IDs. */
#ifdef __APPLE__
#define _DARWIN_C_SOURCE 1
#endif
#define _XOPEN_SOURCE 700
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static int safe_token(const char *s, size_t min, size_t max) {
  size_t n = s ? strlen(s) : 0;
  if (n < min || n > max) return 0;
  for (size_t i=0;i<n;i++) if (!((s[i]>='a'&&s[i]<='z')||(s[i]>='A'&&s[i]<='Z')||(s[i]>='0'&&s[i]<='9')||strchr("._-/:@",s[i]))) return 0;
  return 1;
}
static int is_id(const char *s) {
  if (!s || strlen(s)!=64) return 0;
  for (size_t i=0;i<64;i++) if (!((s[i]>='a'&&s[i]<='f')||(s[i]>='0'&&s[i]<='9'))) return 0;
  return 1;
}
static int is_token(const char *s){
  if(!s||strlen(s)!=32)return 0;
  for(size_t i=0;i<32;i++)if(!((s[i]>='a'&&s[i]<='f')||(s[i]>='0'&&s[i]<='9')))return 0;
  return 1;
}
static int safe_path(const char *s){
  if(!s||s[0]!='/'||strstr(s,"/../")||strstr(s,"//"))return 0;
  size_t n=strlen(s);if(n>4095||(n>=3&&!strcmp(s+n-3,"/..")))return 0;
  for(size_t i=0;i<n;i++)if((unsigned char)s[i]<32||(unsigned char)s[i]==127)return 0;
  return 1;
}
static int owner_alive(pid_t pid) { return pid > 1 && (kill(pid,0)==0 || errno==EPERM); }
static unsigned long long process_start(pid_t pid){
#ifdef __linux__
  char path[64],line[4096];if(snprintf(path,sizeof path,"/proc/%ld/stat",(long)pid)>=(int)sizeof path)return 0;FILE *f=fopen(path,"r");if(!f)return 0;if(!fgets(line,sizeof line,f)){fclose(f);return 0;}fclose(f);char *cursor=strrchr(line,')');if(!cursor||cursor[1]!=' ')return 0;cursor+=2;char *save=NULL,*token=strtok_r(cursor," ",&save);for(int field=3;token;field++,token=strtok_r(NULL," ",&save))if(field==22){char *end=NULL;unsigned long long value=strtoull(token,&end,10);return end&&(*end=='\0'||*end=='\n')?value:0;}return 0;
#else
  (void)pid;return 0;
#endif
}
static int same_owner(pid_t pid,unsigned long long started){if(!owner_alive(pid))return 0;unsigned long long current=process_start(pid);return !started||!current||started==current;}
static int wait_bounded(pid_t child,int *status,int seconds){
  struct timespec delay={0,100000000};
  for(int i=0;i<seconds*10;i++){pid_t r=waitpid(child,status,WNOHANG);if(r==child)return 0;if(r<0&&errno!=EINTR)return -1;while(nanosleep(&delay,&delay)&&errno==EINTR){}delay.tv_sec=0;delay.tv_nsec=100000000;}
  (void)kill(child,SIGKILL);
  for(int i=0;i<10;i++){pid_t r=waitpid(child,status,WNOHANG);if(r==child)return -1;if(r<0&&errno!=EINTR)return -1;while(nanosleep(&delay,&delay)&&errno==EINTR){}delay.tv_sec=0;delay.tv_nsec=100000000;}
  return -1;
}
static int resource_present(const char *run_dir,const char *docker,const char *endpoint,const char *id){
  char output[4096];if(snprintf(output,sizeof output,"%s/watchdog.ps.%ld",run_dir,(long)getpid())>=(int)sizeof output)return -1;
  int fd=open(output,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600);if(fd<0)return -1;
  pid_t child=fork();if(child<0){close(fd);unlink(output);return -1;}
  if(child==0){
    if(dup2(fd,STDOUT_FILENO)<0)_exit(127);
    close(fd);
    int nullfd=open("/dev/null",O_WRONLY);if(nullfd>=0){(void)dup2(nullfd,STDERR_FILENO);close(nullfd);}
    char filter[80];if(snprintf(filter,sizeof filter,"id=%s",id)>=(int)sizeof filter)_exit(127);
    char *const argv[]={(char*)docker,"--host",(char*)endpoint,"ps","--all","--quiet","--no-trunc","--filter",filter,NULL};
    char *const envp[]={"PATH=/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",NULL};execve(docker,argv,envp);_exit(127);
  }
  close(fd);int status=0;if(wait_bounded(child,&status,10)!=0){unlink(output);return -1;}
  if(!WIFEXITED(status)||WEXITSTATUS(status)!=0){unlink(output);return -1;}
  fd=open(output,O_RDONLY|O_NOFOLLOW);if(fd<0){unlink(output);return -1;}char value[128]={0};ssize_t n=read(fd,value,sizeof value-1);close(fd);unlink(output);if(n<0)return -1;
  value[strcspn(value,"\r\n")]=0;if(value[0]==0)return 0;return strcmp(value,id)==0?1:-1;
}
static int remove_container(const char *docker, const char *endpoint, const char *id) {
  pid_t child=fork(); if(child<0)return -1;
  if(child==0){
    char *const argv[]={(char*)docker,"--host",(char*)endpoint,"rm","--force","--volumes",(char*)id,NULL};
    char *const envp[]={"PATH=/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",NULL};
    execve(docker,argv,envp); _exit(127);
  }
  int status=0;if(wait_bounded(child,&status,10)!=0)return -1;
  return WIFEXITED(status)&&WEXITSTATUS(status)==0?0:-1;
}
static int cleanup_label(const char *run_dir,const char *docker,const char *endpoint,const char *label){
  char output[4096],filter[160];if(snprintf(output,sizeof output,"%s/watchdog.labels.%ld",run_dir,(long)getpid())>=(int)sizeof output||snprintf(filter,sizeof filter,"label=com.gstack.cso.run=%s",label)>=(int)sizeof filter)return -1;
  int fd=open(output,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600);if(fd<0)return -1;pid_t child=fork();if(child<0){close(fd);unlink(output);return -1;}
  if(child==0){if(dup2(fd,STDOUT_FILENO)<0)_exit(127);close(fd);int nullfd=open("/dev/null",O_WRONLY);if(nullfd>=0){(void)dup2(nullfd,STDERR_FILENO);close(nullfd);}char *const argv[]={(char*)docker,"--host",(char*)endpoint,"ps","--all","--quiet","--no-trunc","--filter",filter,NULL};char *const envp[]={"PATH=/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",NULL};execve(docker,argv,envp);_exit(127);}
  close(fd);int status=0;if(wait_bounded(child,&status,10)!=0||!WIFEXITED(status)||WEXITSTATUS(status)!=0){unlink(output);return -1;}
  FILE *f=fopen(output,"r");if(!f){unlink(output);return -1;}char line[256];int failed=0;while(fgets(line,sizeof line,f)){line[strcspn(line,"\r\n")]=0;if(!is_id(line)||remove_container(docker,endpoint,line)!=0)failed=1;}fclose(f);unlink(output);return failed?-1:0;
}
static int cleanup(const char *run_dir,const char *docker,const char *endpoint,const char *label){
  char journal[4096]; if(snprintf(journal,sizeof journal,"%s/resources.journal",run_dir)>=(int)sizeof journal)return -1;
  FILE *f=fopen(journal,"r");char line[256];int malformed=0;
  if(f){while(fgets(line,sizeof line,f)){size_t length=strlen(line);int complete=length>0&&(line[length-1]=='\n'||feof(f));line[strcspn(line,"\r\n")]=0;if(!complete||strncmp(line,"container:",10)!=0||!is_id(line+10)){malformed=1;continue;}int present=resource_present(run_dir,docker,endpoint,line+10);if(present>0)(void)remove_container(docker,endpoint,line+10);}if(ferror(f))malformed=1;fclose(f);}else if(errno!=ENOENT)malformed=1;
  /* The journal is an optimization and may end in a torn append. Two exact
   * label sweeps are the authoritative cleanup proof after owner death. */
  if(cleanup_label(run_dir,docker,endpoint,label)!=0)return -1;
  if(cleanup_label(run_dir,docker,endpoint,label)!=0)return -1;
  return malformed?1:0;
}
static int remove_tree(const char *path);
static int owned_regular(const char *path){struct stat st;return !lstat(path,&st)&&S_ISREG(st.st_mode)&&st.st_uid==getuid()&&st.st_nlink==1;}
static int lease_token_matches(const char *dir,const char *token){
  char path[4096];if(snprintf(path,sizeof path,"%s/lease.token",dir)>=(int)sizeof path)return -1;
  struct stat before;if(lstat(path,&before))return errno==ENOENT?0:-1;if(!S_ISREG(before.st_mode)||before.st_uid!=getuid()||before.st_nlink!=1||before.st_size<=0||before.st_size>64)return -1;
  int fd=open(path,O_RDONLY|O_NOFOLLOW);if(fd<0)return -1;struct stat opened;if(fstat(fd,&opened)||opened.st_dev!=before.st_dev||opened.st_ino!=before.st_ino||opened.st_nlink!=1){close(fd);return -1;}char value[64]={0};ssize_t n=read(fd,value,sizeof value-1);struct stat after;int bad=fstat(fd,&after)||after.st_dev!=opened.st_dev||after.st_ino!=opened.st_ino||after.st_nlink!=1;close(fd);if(n<0||bad)return -1;value[strcspn(value,"\r\n")]=0;return strcmp(value,token)==0?1:-1;
}
static int cleanup_release_tomb(const char *tomb,const char *token){
  struct stat root;if(lstat(tomb,&root))return errno==ENOENT?0:-1;if(!S_ISDIR(root.st_mode)||root.st_uid!=getuid())return -1;
  int authenticated=lease_token_matches(tomb,token);if(authenticated<0)return -1;
  /* A deterministic token-qualified tomb is itself the recovery capability
   * after a crash or a concurrent authenticated TS release removed the token.
   * Delete the token last so ordinary interrupted cleanup remains verifiable. */
  DIR *directory=opendir(tomb);if(!directory)return -1;struct dirent *entry;int failed=0;
  while((entry=readdir(directory))){const char *name=entry->d_name;if(!strcmp(name,".")||!strcmp(name,"..")||!strcmp(name,"lease.token"))continue;char child[4096];if(snprintf(child,sizeof child,"%s/%s",tomb,name)>=(int)sizeof child){failed=1;break;}
    if(!strcmp(name,".recovery")){struct stat st;if(lstat(child,&st)||st.st_uid!=getuid()){failed=1;break;}if(S_ISREG(st.st_mode)&&st.st_nlink==1){if(unlink(child)&&errno!=ENOENT){failed=1;break;}}else if(S_ISDIR(st.st_mode)){if(remove_tree(child)!=0){failed=1;break;}}else{failed=1;break;}continue;}
    if(strcmp(name,"lease.json")&&strncmp(name,".recovery.tmp.",14)&&strncmp(name,"lease.json.tmp.",15)){failed=1;break;}
    if(!owned_regular(child)||(unlink(child)&&errno!=ENOENT)){failed=1;break;}
  }
  if(closedir(directory))failed=1;
  if(failed)return -1;
  char token_path[4096];if(snprintf(token_path,sizeof token_path,"%s/lease.token",tomb)>=(int)sizeof token_path)return -1;
  if(authenticated>0&&unlink(token_path)&&errno!=ENOENT)return -1;
  if(rmdir(tomb)&&errno!=ENOENT)return -1;
  return 0;
}
static int release_lease(const char *path,const char *token){
  if(!safe_path(path)||!is_token(token))return -1;
  char tomb[4096];if(snprintf(tomb,sizeof tomb,"%s.watchdog-release-%s",path,token)>=(int)sizeof tomb)return -1;
  struct stat tomb_st;if(!lstat(tomb,&tomb_st))return cleanup_release_tomb(tomb,token);if(errno!=ENOENT)return -1;
  struct stat observed;if(lstat(path,&observed))return errno==ENOENT?0:-1;if(!S_ISDIR(observed.st_mode)||observed.st_uid!=getuid())return -1;
  if(lease_token_matches(path,token)!=1)return -1;
  if(rename(path,tomb)){if(errno==ENOENT&&!lstat(tomb,&tomb_st))return cleanup_release_tomb(tomb,token);return -1;}
  struct stat moved;if(lstat(tomb,&moved)||!S_ISDIR(moved.st_mode)||moved.st_dev!=observed.st_dev||moved.st_ino!=observed.st_ino||moved.st_uid!=observed.st_uid)return -1;
  return cleanup_release_tomb(tomb,token);
}
static void marker(const char *run_dir,const char *name,const char *value){
  char path[4096],tmp[4096];
  if(snprintf(path,sizeof path,"%s/%s",run_dir,name)>=(int)sizeof path)return;
  if(snprintf(tmp,sizeof tmp,"%s/%s.tmp.%ld",run_dir,name,(long)getpid())>=(int)sizeof tmp)return;
  int fd=open(tmp,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600);if(fd<0)return;
  size_t remaining=strlen(value);const char *cursor=value;int failed=0;
  while(remaining){ssize_t written=write(fd,cursor,remaining);if(written>0){cursor+=written;remaining-=(size_t)written;continue;}if(written<0&&errno==EINTR)continue;failed=1;break;}
  if(!failed&&fsync(fd))failed=1;
  if(close(fd))failed=1;
  if(!failed&&!rename(tmp,path))return;
  (void)unlink(tmp);
}
static int descendant(const char *root,const char *path){size_t n=strlen(root);return n>1&&!strncmp(root,path,n)&&path[n]=='/';}
static int remove_tree(const char *path){
  struct stat st;if(lstat(path,&st)){return errno==ENOENT?0:-1;}if(!S_ISDIR(st.st_mode)||st.st_uid!=getuid())return -1;
  pid_t child=fork();if(child<0)return -1;if(child==0){char *const args[]={"/bin/rm","-rf","--",(char*)path,NULL};char *const envp[]={"PATH=/usr/bin:/bin",NULL};execve("/bin/rm",args,envp);_exit(127);}int status=0;if(wait_bounded(child,&status,10)!=0)return -1;return WIFEXITED(status)&&WEXITSTATUS(status)==0?0:-1;
}
static int attempt_watchdog(int argc,char **argv){
  if(argc!=11||strcmp(argv[1],"--attempt-owner")||strcmp(argv[3],"--deadline")||strcmp(argv[5],"--control-dir")||strcmp(argv[7],"--work-root")||strcmp(argv[9],"--run-root"))return 64;
  char *end=NULL;long owner_l=strtol(argv[2],&end,10);if(!end||*end||owner_l<=1)return 64;end=NULL;long long deadline=strtoll(argv[4],&end,10);if(!end||*end||deadline<=0)return 64;
  const char *control=argv[6],*work=argv[8],*run=argv[10];if(!safe_path(control)||!safe_path(work)||!safe_path(run)||!descendant(run,control)||!descendant(run,work))return 64;
  char real_run[4096],real_control[4096],real_work[4096];if(!realpath(run,real_run)||!realpath(control,real_control)||!realpath(work,real_work)||strcmp(real_run,run)||strcmp(real_control,control)||strcmp(real_work,work)||!descendant(real_run,real_control)||!descendant(real_run,real_work))return 64;
  struct stat st;if(lstat(control,&st)||!S_ISDIR(st.st_mode)||st.st_uid!=getuid()||lstat(work,&st)||!S_ISDIR(st.st_mode)||st.st_uid!=getuid())return 64;
  char terminal[4096];if(snprintf(terminal,sizeof terminal,"%s/attempt.terminal",control)>=(int)sizeof terminal)return 64;unsigned long long owner_start=process_start((pid_t)owner_l);marker(control,"attempt.ready","ready\n");
  for(;;){if(access(terminal,F_OK)==0){marker(control,"attempt.stopped","normal cleanup acknowledged\n");return 0;}time_t now=time(NULL);int alive=same_owner((pid_t)owner_l,owner_start);if(!alive||(long long)now>=deadline){if(remove_tree(work)==0){marker(control,"attempt.event",!alive?"supervisor-death execution-copy cleanup complete\n":"deadline execution-copy cleanup complete\n");return 0;}marker(control,"attempt.event","execution-copy cleanup incomplete; retrying\n");}struct timespec delay={0,100000000};while(nanosleep(&delay,&delay)&&errno==EINTR){}delay.tv_sec=0;delay.tv_nsec=100000000;}
}
static int ephemeral_watchdog(int argc,char **argv){
  if(argc!=11||strcmp(argv[1],"--ephemeral-owner")||strcmp(argv[3],"--deadline")||strcmp(argv[5],"--control-dir")||strcmp(argv[7],"--work-root")||strcmp(argv[9],"--run-root"))return 64;
  char *end=NULL;long owner_l=strtol(argv[2],&end,10);if(!end||*end||owner_l<=1)return 64;end=NULL;long long deadline=strtoll(argv[4],&end,10);if(!end||*end||deadline<=0)return 64;
  const char *control=argv[6],*work=argv[8],*run=argv[10];if(!safe_path(control)||!safe_path(work)||!safe_path(run)||!descendant(run,work)||!descendant(work,control))return 64;
  char real_run[4096],real_control[4096],real_work[4096];if(!realpath(run,real_run)||!realpath(control,real_control)||!realpath(work,real_work)||strcmp(real_run,run)||strcmp(real_control,control)||strcmp(real_work,work)||!descendant(real_run,real_work)||!descendant(real_work,real_control))return 64;
  struct stat control_st,work_st;if(lstat(control,&control_st)||!S_ISDIR(control_st.st_mode)||control_st.st_uid!=getuid()||lstat(work,&work_st)||!S_ISDIR(work_st.st_mode)||work_st.st_uid!=getuid())return 64;
  char terminal[4096];if(snprintf(terminal,sizeof terminal,"%s/attempt.terminal",control)>=(int)sizeof terminal)return 64;unsigned long long owner_start=process_start((pid_t)owner_l);marker(control,"attempt.ready","ready\n");
  for(;;){
    int terminal_requested=access(terminal,F_OK)==0;time_t now=time(NULL);int alive=same_owner((pid_t)owner_l,owner_start);
    if(terminal_requested||!alive||(long long)now>=deadline){
      struct stat current;if(lstat(work,&current)){if(errno==ENOENT)return 0;marker(control,"attempt.event","ephemeral cleanup incomplete; retrying\n");}
      else if(!S_ISDIR(current.st_mode)||current.st_uid!=getuid()||current.st_dev!=work_st.st_dev||current.st_ino!=work_st.st_ino){marker(control,"attempt.event","ephemeral cleanup identity changed; refusing removal\n");}
      else if(remove_tree(work)==0)return 0;
      else marker(control,"attempt.event","ephemeral cleanup incomplete; retrying\n");
    }
    struct timespec delay={0,100000000};while(nanosleep(&delay,&delay)&&errno==EINTR){}delay.tv_sec=0;delay.tv_nsec=100000000;
  }
}
int main(int argc,char **argv){
  if(argc>1&&!strcmp(argv[1],"--attempt-owner"))return attempt_watchdog(argc,argv);
  if(argc>1&&!strcmp(argv[1],"--ephemeral-owner"))return ephemeral_watchdog(argc,argv);
  if(argc!=21||strcmp(argv[1],"--owner")||strcmp(argv[3],"--deadline")||strcmp(argv[5],"--run-dir")||strcmp(argv[7],"--docker")||strcmp(argv[9],"--endpoint")||strcmp(argv[11],"--socket-device")||strcmp(argv[13],"--socket-inode")||strcmp(argv[15],"--run-label")||strcmp(argv[17],"--lease-path")||strcmp(argv[19],"--lease-token"))return 64;
  char *end=NULL;long owner_l=strtol(argv[2],&end,10);if(!end||*end||owner_l<=1)return 64;
  end=NULL;long long deadline=strtoll(argv[4],&end,10);if(!end||*end||deadline<=0)return 64;
  end=NULL;unsigned long long socket_device=strtoull(argv[12],&end,10);if(!end||*end)return 64;
  end=NULL;unsigned long long socket_inode=strtoull(argv[14],&end,10);if(!end||*end||!socket_inode)return 64;
  const char *run_dir=argv[6],*docker=argv[8],*endpoint=argv[10],*label=argv[16],*lease_path=argv[18],*lease_token=argv[20];
  if(!safe_path(run_dir)||!safe_path(docker)||!safe_token(label,1,100)||!safe_path(lease_path)||!is_token(lease_token)||strncmp(endpoint,"unix:///",8)||!safe_path(endpoint+7))return 64;
  struct stat docker_st;if(lstat(docker,&docker_st)||!S_ISREG(docker_st.st_mode)||(docker_st.st_mode&0111)==0)return 64;
  struct stat st;if(lstat(run_dir,&st)||!S_ISDIR(st.st_mode)||st.st_uid!=getuid())return 64;
  const char *socket_path=endpoint+7;if(lstat(socket_path,&st)||!S_ISSOCK(st.st_mode)||(unsigned long long)st.st_dev!=socket_device||(unsigned long long)st.st_ino!=socket_inode)return 64;
  char terminal[4096];if(snprintf(terminal,sizeof terminal,"%s/watchdog.terminal",run_dir)>=(int)sizeof terminal)return 64;
  unsigned long long owner_start=process_start((pid_t)owner_l);marker(run_dir,"watchdog.ready","ready\n");
  for(;;){
    while(waitpid(-1,NULL,WNOHANG)>0){}
    if(access(terminal,F_OK)==0){marker(run_dir,"watchdog.stopped","normal cleanup acknowledged\n");return 0;}
    time_t now=time(NULL);
    int alive=same_owner((pid_t)owner_l,owner_start);if(!alive||(long long)now>=deadline){
      if(lstat(socket_path,&st)||!S_ISSOCK(st.st_mode)||(unsigned long long)st.st_dev!=socket_device||(unsigned long long)st.st_ino!=socket_inode){marker(run_dir,"watchdog.event","Docker socket identity changed; cleanup and lease release blocked\n");continue;}
      int cleaned=cleanup(run_dir,docker,endpoint,label);
      if(cleaned>=0&&(!lstat(socket_path,&st)&&S_ISSOCK(st.st_mode)&&(unsigned long long)st.st_dev==socket_device&&(unsigned long long)st.st_ino==socket_inode)&&release_lease(lease_path,lease_token)==0){if(cleaned>0)marker(run_dir,"watchdog.event",!alive?"supervisor-death cleanup complete; malformed journal ignored after two exact label sweeps\n":"deadline cleanup complete; malformed journal ignored after two exact label sweeps\n");else marker(run_dir,"watchdog.event",!alive?"supervisor-death cleanup complete\n":"deadline cleanup complete\n");return 0;}
      marker(run_dir,"watchdog.event","cleanup incomplete; retrying exact journaled resources\n");
    }
    struct timespec delay={0,100000000};while(nanosleep(&delay,&delay)&&errno==EINTR){}
  }
}
