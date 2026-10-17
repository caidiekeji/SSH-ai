//! Command risk grading (PRD §5.5) — five layers of defense-in-depth.
//!
//! The local grade is the ONLY decision input. The AI's `risk_hint` is
//! display-only and can NEVER lower a grade (tested).

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    Green,
    Yellow,
    Red,
}

impl RiskLevel {
    pub fn label(&self) -> &'static str {
        match self {
            RiskLevel::Green => "绿",
            RiskLevel::Yellow => "黄",
            RiskLevel::Red => "红",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RiskAssessment {
    pub level: RiskLevel,
    /// Name of the rule that fired (empty for default-yellow).
    pub rule: String,
    /// Human-readable explanation for the confirm dialog.
    pub reason: String,
}

struct Rule {
    name: &'static str,
    re: Regex,
    reason: &'static str,
}

fn blacklist() -> &'static Vec<Rule> {
    static R: OnceLock<Vec<Rule>> = OnceLock::new();
    R.get_or_init(|| {
        let mk = |name: &'static str, pat: &str, reason: &'static str| Rule {
            name,
            re: Regex::new(pat).expect("valid blacklist regex"),
            reason,
        };
        // PRD §5.5 第一层：黑名单（命中即红，不可降级，不可配置关闭）
        vec![
            mk(
                "rm-rf-root",
                r"rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+/",
                "递归强制删除根路径，可摧毁整个系统",
            ),
            mk(
                "rm-flags-root",
                r"rm\s+-\S+(\s+-\S+)*\s+/",
                "rm 携带参数删除根路径",
            ),
            mk("mkfs", r"mkfs\.\w+", "格式化文件系统"),
            mk(
                "dd-disk",
                r"dd\s+.*of=/dev/(sd|nvme|vd)",
                "dd 直接写物理磁盘，可覆盖全部数据",
            ),
            mk(
                "redirect-disk",
                r">\s*/dev/(sd|nvme|vd)",
                "向物理磁盘重定向数据",
            ),
            mk(
                "power",
                r"(^|[\s;|&])(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b",
                "关机/重启主机",
            ),
            mk(
                "iptables-flush",
                r"iptables\s+(-F|--flush)",
                "清空全部防火墙规则",
            ),
            mk(
                "chmod-777-root",
                r"chmod\s+-R\s+777\s+/",
                "递归放开根路径全部权限",
            ),
            mk(
                "passwd-change",
                r"(^|[\s;|&])passwd\s+\S+",
                "修改用户密码",
            ),
            mk(
                "wipe-fork-bomb",
                r":\(\)\{.*\};:",
                "疑似 fork 炸弹",
            ),
            mk(
                "history-wipe",
                r"(history\s+-c|shred\s+/|wipefs\s+)",
                "清除历史/擦除磁盘签名",
            ),
        ]
    })
}

fn write_rules() -> &'static Vec<Rule> {
    static R: OnceLock<Vec<Rule>> = OnceLock::new();
    R.get_or_init(|| {
        let mk = |name: &'static str, pat: &str, reason: &'static str| Rule {
            name,
            re: Regex::new(pat).expect("valid write regex"),
            reason,
        };
        // PRD §5.5 第二层：写操作模式识别（命中即黄）
        vec![
            mk(
                "system-path-write",
                r"(\bcp\b|\bmv\b|\brm\b|\btee\b|>>?|truncate|sed\s+-i)\s+[^;|&]*\s+/(etc|boot|usr/lib|var/lib)\b|\s/(etc|boot|usr/lib|var/lib)\S*\s*$",
                "写入系统关键路径（/etc、/boot、/usr/lib、/var/lib）",
            ),
            mk(
                "service-stop",
                r"(systemctl\s+(stop|disable|mask|restart)|service\s+\S+\s+(stop|restart))\b",
                "停止/禁用系统服务",
            ),
            mk(
                "pkg-install",
                r"(\bapt(-get)?\s+(install|remove|purge|upgrade)\b|\byum\s+(install|remove|erase)\b|\bdnf\s+(install|remove|erase)\b|\bpacman\s+-[RS]\b|\bapk\s+(add|del)\b)",
                "包管理写操作（安装/卸载/升级软件包）",
            ),
            mk(
                "npm-global",
                r"npm\s+install\s+(-g|--global)",
                "全局安装 npm 包",
            ),
            mk(
                "perm-change",
                r"(^|[\s;|&])(chmod|chown|chgrp|setfacl)\b",
                "修改文件权限或属主",
            ),
            mk(
                "git-destructive",
                r"git\s+reset\s+--hard|git\s+clean\s+-[a-zA-Z]*f",
                "丢弃工作区改动（git reset --hard / git clean）",
            ),
            mk(
                "user-mgmt",
                r"(^|[\s;|&])(useradd|userdel|usermod|groupadd|groupdel|adduser|deluser)\b",
                "用户/组管理操作",
            ),
            mk(
                "docker-write",
                r"docker\s+(rm|rmi|system\s+prune|volume\s+rm)\b",
                "删除容器/镜像/卷",
            ),
            mk(
                "kill-process",
                r"(^|[\s;|&])(kill|pkill|killall)\b",
                "终止进程",
            ),
            mk(
                "file-write",
                r"(^|[\s;|&])(rm|mv|truncate)\s+\S",
                "删除/移动/截断文件",
            ),
            mk(
                "redirect-write",
                r"\S\s*>>?\s*\S",
                "重定向写入文件",
            ),
        ]
    })
}

fn read_rules() -> &'static Vec<Rule> {
    static R: OnceLock<Vec<Rule>> = OnceLock::new();
    R.get_or_init(|| {
        let mk = |pat: &str| Rule {
            name: "read-only",
            re: Regex::new(pat).expect("valid read regex"),
            reason: "只读命令",
        };
        // PRD §5.5 第三层：只读白名单（命中即绿，仍需用户按 Enter）
        vec![
            mk(r"^(ls|cat|head|tail|less|more|df|du|free|uptime|whoami|hostname|date|which|whereis|env|printenv|id)\b"),
            mk(r"^(grep|egrep|fgrep|zgrep|find|stat|file|wc|sort|uniq|diff|journalctl|dmesg)\b"),
            mk(r"^(ps|ss|netstat|lsof|ifconfig|ip\s+(a|addr|link|route)\b|ping|dig|host|curl\s+(-I|--head)|wget\s+--spider)"),
            mk(r"^systemctl\s+(status|list-unit|list-dependencies|is-active|is-enabled|show)\b"),
            mk(r"^(docker\s+(ps|logs|inspect|images|info|version)|kubectl\s+(get|describe|logs|top)\b)"),
            mk(r"^(apt(-get)?\s+(list|search|show|showpkg)\b|yum\s+(list|search|info)\b|dnf\s+(list|search|info)\b|pip\s+(list|show|search)\b|npm\s+(list|ls|search|info|view)\b)"),
            mk(r"^(echo|printf)\b[^>]*$"),
            mk(r"^git\s+(status|log|diff|show|branch|remote|blame)\b"),
            mk(r"^uname\b|^lsb_release\b|^cat\s+/etc/os-release\b"),
        ]
    })
}

/// User whitelist: EXACT string match only. Never overrides the blacklist
/// (PRD §5.5 第五层). Stored by commands.rs, loaded per grading call.
pub struct RiskEngine {
    pub whitelist: Mutex<Vec<String>>,
}

impl Default for RiskEngine {
    fn default() -> Self {
        Self {
            whitelist: Mutex::new(Vec::new()),
        }
    }
}

impl RiskEngine {
    /// Layered grading (PRD §5.5). `ai_risk_hint` is accepted ONLY for the
    /// report; it can never influence the level.
    pub fn assess(&self, command: &str, ai_risk_hint: &str) -> RiskAssessment {
        let cmd = command.trim();
        let _ = ai_risk_hint; // explicitly unused for the decision

        // Layer 1: blacklist (RED, cannot be downgraded).
        for r in blacklist() {
            if r.re.is_match(cmd) {
                return RiskAssessment {
                    level: RiskLevel::Red,
                    rule: r.name.to_string(),
                    reason: r.reason.to_string(),
                };
            }
        }

        // Layer 5 (inverted priority): user whitelist skips confirmation ONLY
        // for non-blacklisted commands, and only on exact text match.
        {
            let wl = self.whitelist.lock().unwrap_or_else(|e| e.into_inner());
            if wl.iter().any(|w| w == cmd) {
                return RiskAssessment {
                    level: RiskLevel::Green,
                    rule: "user-whitelist".into(),
                    reason: "用户白名单（精确匹配）".into(),
                };
            }
        }

        // Layer 3: read-only whitelist (GREEN).
        // find(1) is only read-only WITHOUT -delete / -exec; guard it.
        let find_guarded =
            cmd.starts_with("find ") && (cmd.contains("-delete") || cmd.contains("-exec"));
        if !find_guarded {
            for r in read_rules() {
                if r.re.is_match(cmd) {
                    return RiskAssessment {
                        level: RiskLevel::Green,
                        rule: r.name.to_string(),
                        reason: r.reason.to_string(),
                    };
                }
            }
        }

        // Layer 2: write-operation patterns (YELLOW).
        for r in write_rules() {
            if r.re.is_match(cmd) {
                return RiskAssessment {
                    level: RiskLevel::Yellow,
                    rule: r.name.to_string(),
                    reason: r.reason.to_string(),
                };
            }
        }

        // Layer 4: default YELLOW (conservative).
        RiskAssessment {
            level: RiskLevel::Yellow,
            rule: "default".into(),
            reason: "未知命令，按中风险处理（保守策略）".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grade(cmd: &str, hint: &str) -> RiskAssessment {
        RiskEngine::default().assess(cmd, hint)
    }

    // PRD §8.3 test_blacklist_hits_red
    #[test]
    fn test_blacklist_hits_red() {
        for cmd in [
            "rm -rf /",
            "rm -fr /data",
            "rm -r -f /",
            "sudo rm -rf / --no-preserve-root",
            "mkfs.ext4 /dev/sda1",
            "mkfs.xfs /dev/nvme0n1",
            "dd if=/dev/zero of=/dev/sda",
            "dd bs=4M if=img.iso of=/dev/nvme0n1",
            "echo x > /dev/sda",
            "shutdown -h now",
            "reboot",
            "iptables -F",
            "iptables --flush",
            "chmod -R 777 /",
            "passwd root",
            ":(){ :|:& };:",
        ] {
            let a = grade(cmd, "read");
            assert_eq!(a.level, RiskLevel::Red, "expected RED for: {cmd}");
        }
    }

    // PRD §8.3 test_blacklist_not_overridden_by_ai_hint
    #[test]
    fn test_blacklist_not_overridden_by_ai_hint() {
        let a = grade("rm -rf /", "read");
        assert_eq!(a.level, RiskLevel::Red);
        let b = grade("mkfs.ext4 /dev/sda", "read");
        assert_eq!(b.level, RiskLevel::Red);
    }

    #[test]
    fn green_read_only() {
        for cmd in [
            "ls -la",
            "cat /var/log/syslog",
            "df -h",
            "du -sh /var",
            "ps aux",
            "ss -tlnp",
            "grep error /var/log/app.log",
            "find /var/log -name '*.log'",
            "systemctl status nginx",
            "journalctl -u nginx --since today",
            "docker ps -a",
            "docker logs web01",
            "kubectl get pods -n default",
            "kubectl describe pod web",
            "uname -a",
        ] {
            let a = grade(cmd, "");
            assert_eq!(a.level, RiskLevel::Green, "expected GREEN for: {cmd}");
        }
    }

    #[test]
    fn find_with_delete_not_green() {
        // PRD: find WITHOUT -delete/-exec rm is green; with them it must not be.
        let a = grade("find /tmp -name '*.tmp' -delete", "");
        assert_ne!(a.level, RiskLevel::Green);
        let b = grade("find / -exec rm {} \\;", "read");
        assert_ne!(b.level, RiskLevel::Green);
    }

    #[test]
    fn yellow_write_ops() {
        for cmd in [
            "apt install nginx",
            "apt-get remove docker",
            "yum install htop",
            "npm install -g typescript",
            "systemctl stop nginx",
            "systemctl disable nginx",
            "chmod 644 /etc/nginx/nginx.conf",
            "chown www-data /var/www",
            "git reset --hard HEAD~1",
            "git clean -fd",
            "kill 1234",
            "docker rm web01",
            "echo hello > /etc/motd",
            "cp app.conf /etc/app/app.conf",
        ] {
            let a = grade(cmd, "read");
            assert_eq!(a.level, RiskLevel::Yellow, "expected YELLOW for: {cmd}");
        }
    }

    // PRD §5.5 第四层：默认 YELLOW
    #[test]
    fn unknown_defaults_yellow() {
        let a = grade("frobnicate --turbo /dev/data", "read");
        assert_eq!(a.level, RiskLevel::Yellow);
        assert_eq!(a.rule, "default");
    }

    // PRD §5.5 第五层：用户白名单只跳过确认，不覆盖黑名单
    #[test]
    fn whitelist_exact_match_skips_confirm_but_not_blacklist() {
        let engine = RiskEngine::default();
        engine
            .whitelist
            .lock()
            .unwrap()
            .push("systemctl restart myapp".to_string());

        let a = engine.assess("systemctl restart myapp", "write");
        assert_eq!(a.level, RiskLevel::Green);

        // Non-exact match still graded normally.
        let b = engine.assess("systemctl restart myapp2", "");
        assert_eq!(b.level, RiskLevel::Yellow);

        // Blacklist still wins over whitelist.
        engine.whitelist.lock().unwrap().push("rm -rf /".to_string());
        let c = engine.assess("rm -rf /", "read");
        assert_eq!(c.level, RiskLevel::Red);
    }
}
