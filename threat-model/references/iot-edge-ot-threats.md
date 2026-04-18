# IoT / Edge / OT Threat Taxonomy

Read this file when the component involves IoT devices, edge computing, industrial
control systems (ICS), SCADA, PLCs, or operational technology of any kind.

---

## IoT Device Security

### Device Authentication & Identity
- Default credentials on devices (admin/admin, root/root — often unpatchable)
- Hardcoded credentials in firmware (extractable via binary analysis)
- No unique device identity (shared symmetric keys across fleet)
- Certificate provisioning at scale without secure enrollment process
- Device impersonation — no attestation of device integrity at connection time
- Decommissioned devices retaining valid credentials

### Firmware & Software
- No secure boot (unsigned firmware loadable)
- Firmware update over cleartext HTTP (MITM → malicious firmware injection)
- No firmware signature verification on device
- Firmware rollback attacks (installing vulnerable older version)
- Embedded secrets in firmware (API keys, certificates extractable via binwalk/strings)
- JTAG/UART debug interfaces accessible on production hardware
- Open bootloader enabling arbitrary code execution

### Device Communication
- MQTT without authentication (default for many brokers)
- MQTT without TLS (topic interception, message injection)
- MQTT wildcard subscription (`#`) allowing topic enumeration of entire broker
- CoAP without DTLS (cleartext UDP communication)
- BLE (Bluetooth Low Energy) pairing without authentication
- Zigbee/Z-Wave with known protocol-level vulnerabilities
- Device-to-cloud communication without certificate pinning
- Cleartext telemetry containing sensitive operational data

---

## Edge Computing

### Edge Node Security
- Edge node with local admin access not centrally managed
- Edge container runtime with elevated privileges
- Edge node physically accessible in remote/unmonitored locations
- Edge node with stale OS/software (manual patching in disconnected environments)
- Edge node storing sensitive data without encryption at rest
- Local model inference with unprotected model weights (IP theft)

### Edge-to-Cloud Communication
- Edge node with persistent cloud credentials (compromise edge = access cloud)
- Data synchronization conflicts between edge and cloud (split-brain)
- Edge node acting as gateway with overly broad forwarding rules
- Offline operation period accumulating unaudited actions
- Edge device enrollment without mutual authentication

---

## Operational Technology (OT)

### ICS / SCADA
- OT network not segmented from IT network (flat network → IT compromise reaches OT)
- Purdue Model levels not enforced (L3/L2/L1/L0 boundaries not hardened)
- OT protocols without authentication (Modbus, DNP3, OPC DA, BACnet, EtherNet/IP)
- SCADA HMI exposed on IT network or internet
- Historian servers bridging IT and OT (dual-homed attack vector)
- Remote access to OT via VPN without MFA or endpoint compliance
- OT systems running unsupported OS (Windows XP, Windows 7, Windows Server 2003)
- No change management on PLC/RTU programs (unauthorized logic changes undetected)

### PLC / RTU / DCS
- PLC programming port accessible over network (program upload/download without auth)
- PLC firmware vulnerable to Stuxnet-class attacks (logic manipulation)
- Safety Instrumented Systems (SIS) connected to control network (TRITON/TRISIS pattern)
- No integrity verification on PLC ladder logic / function block programs
- PLC denial of service via malformed protocol packets (CPU halt)
- Engineering workstation compromise → direct PLC access

### OT-Specific Attack Patterns
- Living-off-the-land in OT (using legitimate OT tools for malicious purposes)
- Process manipulation without triggering alarms (subtle setpoint changes)
- Safety system override or bypass (disabling safety interlocks)
- Physical consequence attacks (equipment damage, environmental release, human safety)
- Supply chain compromise of OT vendor software/firmware (SolarWinds pattern in OT)
- Ransomware targeting OT (Colonial Pipeline pattern — IT ransomware causing OT shutdown)

### OT Monitoring
- No intrusion detection on OT network (IT IDS cannot parse OT protocols)
- OT device logs not collected or forwarded
- No baseline of normal OT traffic patterns
- Physical process monitoring not correlated with network events
- Incident response plan does not cover OT/physical safety scenarios
