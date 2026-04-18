# Legacy Systems Threat Taxonomy

Read this file when the component involves or integrates with legacy systems:
mainframes, AS/400 (IBM i), COBOL applications, legacy middleware, terminal
emulators, or systems running unsupported operating systems.

---

## Mainframe (z/OS, z/VSE, z/TPF)

### Access Control
- RACF / ACF2 / TopSecret profiles with excessive permissions
- Default RACF user IDs not disabled (IBMUSER, etc.)
- Password rules not enforcing complexity on mainframe logon
- APF-authorized libraries accessible to non-admin users (arbitrary system calls)
- OMVS (Unix System Services) shell access with elevated mainframe privileges
- SVC (Supervisor Calls) exploitable for privilege escalation
- Started task JCL modifiable by non-admin users
- TSO/ISPF session timeout not configured (unattended sessions)

### Network Exposure
- TN3270 terminal access without encryption (cleartext credentials and data)
- TN3270 accessible from corporate network without MFA
- FTP on mainframe transmitting data in cleartext
- MQ Series / CICS connectivity without TLS
- Mainframe APIs (CICS Web Services, z/OS Connect) without modern authentication
- VTAM/SNA network accessible from IP network via gateway without access control

### Application Security
- COBOL programs with buffer overflow vulnerabilities (no bounds checking)
- JCL injection via unsanitized input in batch job parameters
- CICS transaction security not enforced (any user can execute any transaction)
- DB2 for z/OS with dynamic SQL — SQL injection in mainframe applications
- IMS transaction manager without per-transaction authorization
- Batch job submission accessible to unauthorized users (JES2/JES3)
- Screen scraping integrations bypassing mainframe security controls

### Mainframe Modernization Risks
- API layer exposing mainframe transactions without rate limiting or modern auth
- Data exfiltration via modernization integration (mainframe data copied to less-secured cloud)
- Legacy application logic replicated without security review
- Mainframe credentials embedded in modernization middleware configuration

---

## IBM AS/400 (IBM i)

### Access
- Default user profiles not disabled (*SECOFR, QSECOFR, QSYSOPR with known defaults)
- User profiles with *ALLOBJ special authority (equivalent to root)
- Object-level security not enforced (relying on menu-level security — bypassable via command line)
- Authority granted to *PUBLIC on sensitive libraries/objects
- Remote command execution via DDM/DRDA without authentication
- Client Access / ACS with saved credentials
- FTP server enabled with cleartext authentication

### Application
- RPG/COBOL programs without input validation
- SQL injection in embedded SQL (RPG programs with dynamic SQL)
- Green-screen applications with no session management
- Exit point programs not monitoring data access
- Integrated File System (IFS) with world-readable shares
- Journals not configured for audit-critical files

---

## Legacy Middleware

### Message-Oriented Middleware (IBM MQ, TIBCO, Oracle AQ)
- IBM MQ queue manager without channel authentication
- IBM MQ channels without TLS (cleartext message transmission)
- MQ dead letter queue containing sensitive messages
- MQ authority records granting broad access to queues
- TIBCO EMS without user authentication
- Oracle Advanced Queuing with database-level access bypassing queue permissions
- Middleware admin console with default credentials

### Enterprise Service Bus (ESB)
- ESB routing rules manipulable via injected message headers
- ESB transformation exposing data to unauthorized services
- ESB credential store with weak encryption
- Legacy SOAP/WSDL services without WS-Security
- ESB logging capturing message payloads with sensitive data
- No message-level encryption (relying solely on transport encryption)

### Application Servers (WebSphere, WebLogic, JBoss/WildFly, Tomcat)
- Admin console exposed with default credentials (weblogic/welcome1, admin/admin)
- Java deserialization vulnerabilities (Commons Collections, T3/IIOP protocol)
- WebLogic T3 protocol exposed — remote code execution (CVE-2023-21839 and variants)
- JNDI injection leading to RCE (Log4Shell pattern — CVE-2021-44228)
- JMX (Java Management Extensions) exposed without authentication
- WAR/EAR deployment endpoint accessible without authorization
- Server status pages / health endpoints exposing internal state
- Connection pool credentials in cleartext configuration files
- Shared classloader allowing cross-application interference
- Session serialization using Java ObjectInputStream (deserialization attack)

---

## Unsupported Operating Systems

### Windows Legacy (XP, 7, Server 2003/2008/2012)
- No security patches (all known CVEs permanently exploitable)
- EternalBlue (MS17-010) and related SMB exploits
- No modern security features (ASLR, CFG, WDAC limited or absent)
- Legacy authentication protocols (NTLMv1, LM hashes)
- Internet Explorer with known unpatched vulnerabilities
- Impossible to install modern endpoint protection agents
- Registry/GPO hardening limited by OS capabilities

### Unix/Linux Legacy
- Kernel versions with known local privilege escalation exploits
- OpenSSL versions with known vulnerabilities (Heartbleed, etc.)
- No SELinux/AppArmor support (or not enforcing)
- Compilers/interpreters with known vulnerabilities
- Package managers no longer receiving updates
- SSH with deprecated algorithms (DSA keys, CBC ciphers)

### Legacy Integration Patterns
- Terminal emulator session recording capturing credentials
- Screen scraping as integration method (fragile, no access control beyond UI)
- Shared database integration (direct table access across applications)
- File-based integration (drop files in watched directory — race conditions, injection)
- Hardcoded IPs instead of DNS (impossible to migrate, load balance, or failover)
- Custom binary protocols without documentation or security review
- Legacy APIs without authentication, rate limiting, or versioning

---

## Cross-Cutting Legacy Concerns

### Knowledge & Documentation
- System behavior undocumented (original developers retired/departed)
- Security controls unknown (no one knows what RACF/ACF2 profiles actually permit)
- Change management informal (no version control on mainframe code)
- Disaster recovery for legacy untested or nonexistent

### Compliance
- Legacy system unable to meet modern compliance requirements (PCI 4.0, SOC2)
- Audit logging insufficient for regulatory needs
- Data classification not applied to legacy data stores
- Encryption requirements unmet (legacy systems can't support TLS 1.2/1.3)
- Access review impossible without modern IAM integration

### Attack Surface
- Legacy system as persistent foothold (low monitoring, high privilege)
- Air-gap assumptions no longer valid (legacy connected via modernization layer)
- Lateral movement from compromised legacy to modern systems via integration points
- Legacy credentials reused on modern systems (password reuse across eras)
