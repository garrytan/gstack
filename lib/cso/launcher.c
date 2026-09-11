/* Minimal trusted CSO launcher. Linux builds are static so LD_PRELOAD cannot
 * execute before the environment is replaced. macOS builds are signed with
 * the hardened runtime by build/setup before use. */
#ifdef __APPLE__
#define _DARWIN_C_SOURCE 1
#endif
#define _POSIX_C_SOURCE 200809L
#define _XOPEN_SOURCE 700
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

#ifndef GSTACK_CSO_CORE_SHA256
#error GSTACK_CSO_CORE_SHA256 must bind the launcher to its compiled core
#endif

typedef struct {
  uint32_t state[8];
  uint64_t bits;
  unsigned char block[64];
  size_t used;
} sha256_context;

static uint32_t rotate_right(uint32_t value,unsigned count){return(value>>count)|(value<<(32-count));}
static void sha256_transform(sha256_context *context,const unsigned char block[64]){
  static const uint32_t constants[64]={
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  };
  uint32_t words[64];
  for(size_t i=0;i<16;i++)words[i]=((uint32_t)block[i*4]<<24)|((uint32_t)block[i*4+1]<<16)|((uint32_t)block[i*4+2]<<8)|block[i*4+3];
  for(size_t i=16;i<64;i++){
    uint32_t x=words[i-15],y=words[i-2];
    uint32_t first=rotate_right(x,7)^rotate_right(x,18)^(x>>3),second=rotate_right(y,17)^rotate_right(y,19)^(y>>10);
    words[i]=words[i-16]+first+words[i-7]+second;
  }
  uint32_t a=context->state[0],b=context->state[1],c=context->state[2],d=context->state[3],e=context->state[4],f=context->state[5],g=context->state[6],h=context->state[7];
  for(size_t i=0;i<64;i++){
    uint32_t sum1=rotate_right(e,6)^rotate_right(e,11)^rotate_right(e,25),choice=(e&f)^((~e)&g),temporary1=h+sum1+choice+constants[i]+words[i];
    uint32_t sum0=rotate_right(a,2)^rotate_right(a,13)^rotate_right(a,22),majority=(a&b)^(a&c)^(b&c),temporary2=sum0+majority;
    h=g;g=f;f=e;e=d+temporary1;d=c;c=b;b=a;a=temporary1+temporary2;
  }
  context->state[0]+=a;context->state[1]+=b;context->state[2]+=c;context->state[3]+=d;
  context->state[4]+=e;context->state[5]+=f;context->state[6]+=g;context->state[7]+=h;
}
static void sha256_update(sha256_context *context,const unsigned char *data,size_t length){
  context->bits+=(uint64_t)length*8;
  while(length){size_t available=64-context->used,take=length<available?length:available;memcpy(context->block+context->used,data,take);context->used+=take;data+=take;length-=take;if(context->used==64){sha256_transform(context,context->block);context->used=0;}}
}
static void sha256_finish(sha256_context *context,unsigned char digest[32]){
  uint64_t bits=context->bits;context->block[context->used++]=0x80;
  if(context->used>56){memset(context->block+context->used,0,64-context->used);sha256_transform(context,context->block);context->used=0;}
  memset(context->block+context->used,0,56-context->used);for(size_t i=0;i<8;i++)context->block[63-i]=(unsigned char)(bits>>(i*8));sha256_transform(context,context->block);
  for(size_t i=0;i<8;i++){digest[i*4]=(unsigned char)(context->state[i]>>24);digest[i*4+1]=(unsigned char)(context->state[i]>>16);digest[i*4+2]=(unsigned char)(context->state[i]>>8);digest[i*4+3]=(unsigned char)context->state[i];}
}
static int sha256_file(int fd,char output[65]){
  sha256_context context={{0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19},0,{0},0};
  unsigned char buffer[65536],digest[32];
  if(lseek(fd,0,SEEK_SET)<0)return -1;
  for(;;){ssize_t count=read(fd,buffer,sizeof buffer);if(count>0){sha256_update(&context,buffer,(size_t)count);continue;}if(count==0)break;if(errno!=EINTR)return -1;}
  sha256_finish(&context,digest);static const char hex[]="0123456789abcdef";for(size_t i=0;i<32;i++){output[i*2]=hex[digest[i]>>4];output[i*2+1]=hex[digest[i]&15];}output[64]=0;
  return lseek(fd,0,SEEK_SET)<0?-1:0;
}

static int executable_path(char *out,size_t size,const char *argv0){
#ifdef __linux__
  (void)argv0;
  ssize_t n=readlink("/proc/self/exe",out,size-1);if(n<=0||(size_t)n>=size-1)return -1;out[n]=0;return 0;
#elif defined(__APPLE__)
  (void)argv0;
  uint32_t n=(uint32_t)size;if(_NSGetExecutablePath(out,&n)!=0)return -1;char resolved[PATH_MAX];if(!realpath(out,resolved))return -1;if(strlen(resolved)>=size)return -1;strcpy(out,resolved);return 0;
#else
  if(!realpath(argv0,out))return -1;return 0;
#endif
}
static char *fixed_entry(const char *name,const char *value){
  if(strlen(value)>8192)return NULL;
  size_t n=strlen(name)+strlen(value)+2;char *out=malloc(n);if(!out)return NULL;snprintf(out,n,"%s=%s",name,value);return out;
}
static char *entry(const char *name,const char *fallback){const char *value=getenv(name);return fixed_entry(name,value?value:fallback);}
#ifdef GSTACK_CSO_TESTING
static int test_pause(int argc,char **argv,const char *command){
  if(argc!=4||strcmp(argv[1],command))return 0;
  int ready=open(argv[2],O_WRONLY|O_CREAT|O_EXCL,0600);if(ready<0)return -1;close(ready);
  struct timespec wait={0,1000000};while(access(argv[3],F_OK)!=0)nanosleep(&wait,NULL);return 1;
}
#endif
int main(int argc,char **argv){
  char located[PATH_MAX],self[PATH_MAX],caller_cwd[PATH_MAX];
  if(!getcwd(caller_cwd,sizeof caller_cwd)){
    fputs("gstack-cso: caller working directory unavailable\n",stderr);return 69;
  }
  if(executable_path(located,sizeof located,argc?argv[0]:"")!=0||!realpath(located,self)){
    fputs("gstack-cso: launcher path unavailable\n",stderr);return 69;
  }
  char *slash=strrchr(self,'/');if(!slash){fputs("gstack-cso: invalid launcher path\n",stderr);return 69;}
  *slash=0;if(!self[0]){self[0]='/';self[1]=0;}
#ifdef GSTACK_CSO_TESTING
  if(test_pause(argc,argv,"__cso-test-pause-before-generation-lock")<0){fputs("gstack-cso: test generation pause failed\n",stderr);return 69;}
#endif
  int generation_lock=open(self,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
  if(generation_lock<0){fputs("gstack-cso: installation lock unavailable\n",stderr);return 69;}
  while(flock(generation_lock,LOCK_SH)!=0)if(errno!=EINTR){fputs("gstack-cso: installation lock unavailable\n",stderr);return 69;}
  char core[PATH_MAX];if(snprintf(core,sizeof core,"%s%sgstack-cso-core",self,strcmp(self,"/")?"/":"")>=(int)sizeof core){fputs("gstack-cso: core path too long\n",stderr);return 69;}
  int core_fd=openat(generation_lock,"gstack-cso-core",O_RDONLY|O_NOFOLLOW);struct stat core_state,st;
  if(core_fd<0||fstat(core_fd,&core_state)||!S_ISREG(core_state.st_mode)||core_state.st_nlink!=1||(core_state.st_mode&0111)==0){fputs("gstack-cso: trusted compiled helper is missing; run gstack setup/build\n",stderr);return 69;}
  int generation_fd=openat(generation_lock,".gstack-cso-generation",O_RDONLY|O_NOFOLLOW);char actual[66];size_t manifest_used=0;
  if(generation_fd<0||fstat(generation_fd,&st)||!S_ISREG(st.st_mode)||st.st_nlink!=1||st.st_size!=65){fputs("gstack-cso: generation manifest is missing or invalid; run gstack setup/build\n",stderr);return 69;}
  while(manifest_used<65){ssize_t count=read(generation_fd,actual+manifest_used,65-manifest_used);if(count>0){manifest_used+=(size_t)count;continue;}if(count<0&&errno==EINTR)continue;fputs("gstack-cso: generation manifest is missing or invalid; run gstack setup/build\n",stderr);return 69;}
  close(generation_fd);actual[65]='\0';
  if(actual[64]!='\n'||strncmp(actual,GSTACK_CSO_CORE_SHA256,64)!=0){fputs("gstack-cso: launcher and compiled helper generations do not match; run gstack setup/build\n",stderr);return 69;}
  char core_sha256[65];if(sha256_file(core_fd,core_sha256)!=0||strcmp(core_sha256,GSTACK_CSO_CORE_SHA256)!=0){fputs("gstack-cso: compiled helper digest does not match its launcher; run gstack setup/build\n",stderr);return 69;}
#ifdef GSTACK_CSO_TESTING
  if(test_pause(argc,argv,"__cso-test-pause-after-core-verification")<0){fputs("gstack-cso: test core pause failed\n",stderr);return 69;}
#endif
  char *envp[16];size_t e=0;
  envp[e++]=strdup("PATH=/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/sbin:/sbin");
  envp[e++]=strdup("LANG=C.UTF-8");envp[e++]=strdup("LC_ALL=C.UTF-8");envp[e++]=strdup("TZ=UTC");
  const char *names[]={"HOME","GSTACK_HOME","CLAUDE_PLUGIN_DATA","CLAUDE_PLUGIN_ROOT","DOCKER_HOST","DOCKER_CONTEXT","DOCKER_CONFIG"};
  for(size_t i=0;i<sizeof names/sizeof names[0];i++){envp[e]=entry(names[i],"");if(!envp[e++]){fputs("gstack-cso: environment input is too large\n",stderr);return 69;}}
  envp[e]=fixed_entry("GSTACK_CSO_CALLER_CWD",caller_cwd);if(!envp[e++]){fputs("gstack-cso: caller working directory is too large\n",stderr);return 69;}
  char lock_value[32];snprintf(lock_value,sizeof lock_value,"%d",generation_lock);
  envp[e]=fixed_entry("GSTACK_CSO_GENERATION_LOCK_FD",lock_value);if(!envp[e++])return 69;
  envp[e]=NULL;
  char **child=calloc((size_t)argc+1,sizeof(char*));if(!child)return 69;child[0]=core;for(int i=1;i<argc;i++)child[i]=argv[i];
  /* The audited repository is an untrusted input.  Do not let its working
   * directory become implicit process configuration for the compiled core. */
  if(chdir(self)!=0){fputs("gstack-cso: trusted working directory unavailable\n",stderr);return 69;}
#ifdef __linux__
  fexecve(core_fd,child,envp);
#else
  /* macOS has no fexecve. Recheck the directory entry under the shared
   * publication lock immediately before pathname execution. */
  struct stat current;
  if(fstatat(generation_lock,"gstack-cso-core",&current,AT_SYMLINK_NOFOLLOW)!=0||!S_ISREG(current.st_mode)||current.st_dev!=core_state.st_dev||current.st_ino!=core_state.st_ino||current.st_nlink!=1){fputs("gstack-cso: compiled helper changed before execution; run gstack setup/build\n",stderr);return 69;}
  execve(core,child,envp);
#endif
  fprintf(stderr,"gstack-cso: trusted compiled helper could not start (%d)\n",errno);return 69;
}
