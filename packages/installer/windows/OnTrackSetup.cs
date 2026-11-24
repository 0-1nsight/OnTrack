// OnTrack Unified Workstation Installer (Desktop Agent + Browser Extension)
// Compiles cleanly on Windows 10/11 via built-in .NET Framework 4.x csc.exe:
//   csc.exe /nologo /target:winexe /optimize+ /r:System.dll,System.Drawing.dll,System.Windows.Forms.dll,System.IO.Compression.dll,System.IO.Compression.FileSystem.dll /out:OnTrack-Setup.exe OnTrackSetup.cs

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace OnTrackInstaller
{
    public sealed class InstallMeta
    {
        public string ServerUrl = "http://localhost:3000";
        public string TenantId = "";
        public string UserId = "";
        public string BridgeSecret = "";
        public int BridgePort = 47621;
        public int HeartbeatSeconds = 12;
        public int PollSampleMs = 2000;
        public int IdleThresholdSeconds = 180;
    }

    public sealed class SetupForm : Form
    {
        private readonly InstallMeta _meta;
        private readonly string _bundleZipPath;
        private readonly bool _deleteBundleOnExit;
        private readonly string _installRoot;
        private readonly string _agentDir;
        private readonly string _extDir;

        private TextBox _tokenBox;
        private Button _installBtn;
        private Button _closeBtn;
        private Button _openExtBtn;
        private ProgressBar _progressBar;
        private Label _statusLabel;
        private Label _subStatusLabel;
        private CheckBox _openBrowserCheck;
        private bool _isInstalling;
        private bool _completed;

        public SetupForm(InstallMeta meta, string bundleZipPath, bool deleteBundleOnExit, string initialToken)
        {
            _meta = meta;
            _bundleZipPath = bundleZipPath;
            _deleteBundleOnExit = deleteBundleOnExit;
            _installRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "OnTrack"
            );
            _agentDir = Path.Combine(_installRoot, "Agent");
            _extDir = Path.Combine(_installRoot, "Extension");

            InitializeLayout(initialToken);
        }

        private void InitializeLayout(string initialToken)
        {
            this.Text = "OnTrack Collector Setup";
            this.ClientSize = new Size(520, 340);
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.FromArgb(248, 250, 252);
            this.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

            var title = new Label
            {
                Text = "Install OnTrack Desktop & Browser Collector",
                Font = new Font("Segoe UI", 12.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42),
                Location = new Point(24, 20),
                Size = new Size(472, 28)
            };
            this.Controls.Add(title);

            var subtitle = new Label
            {
                Text = string.Format("Server: {0}   |   Workspace: {1}", _meta.ServerUrl, string.IsNullOrEmpty(_meta.TenantId) ? "Configured" : _meta.TenantId),
                Font = new Font("Segoe UI", 8.5f, FontStyle.Regular),
                ForeColor = Color.FromArgb(71, 85, 105),
                Location = new Point(24, 50),
                Size = new Size(472, 20)
            };
            this.Controls.Add(subtitle);

            var tokenLabel = new Label
            {
                Text = "Installation Key (asked once):",
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(30, 41, 59),
                Location = new Point(24, 86),
                Size = new Size(472, 20)
            };
            this.Controls.Add(tokenLabel);

            _tokenBox = new TextBox
            {
                Location = new Point(24, 110),
                Size = new Size(472, 26),
                Font = new Font("Consolas", 9.5f, FontStyle.Regular),
                Text = initialToken ?? ""
            };
            this.Controls.Add(_tokenBox);

            var hintLabel = new Label
            {
                Text = "Paste your ontrack_dev_... Installation Key from your OnTrack Credentials (.txt) file.",
                Font = new Font("Segoe UI", 8.25f, FontStyle.Regular),
                ForeColor = Color.FromArgb(100, 116, 139),
                Location = new Point(24, 140),
                Size = new Size(472, 18)
            };
            this.Controls.Add(hintLabel);

            _openBrowserCheck = new CheckBox
            {
                Text = "Open OnTrack sign-in in browser after installation completes",
                Checked = true,
                Location = new Point(24, 168),
                Size = new Size(472, 22),
                ForeColor = Color.FromArgb(51, 65, 85),
                Font = new Font("Segoe UI", 8.5f, FontStyle.Regular)
            };
            this.Controls.Add(_openBrowserCheck);

            _progressBar = new ProgressBar
            {
                Location = new Point(24, 204),
                Size = new Size(472, 22),
                Minimum = 0,
                Maximum = 100,
                Value = 0,
                Style = ProgressBarStyle.Continuous
            };
            this.Controls.Add(_progressBar);

            _statusLabel = new Label
            {
                Text = "Ready to install Desktop Agent and pre-paired Browser Extension silently.",
                Location = new Point(24, 234),
                Size = new Size(472, 20),
                Font = new Font("Segoe UI", 9f, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42)
            };
            this.Controls.Add(_statusLabel);

            _subStatusLabel = new Label
            {
                Text = string.Format("Install folder: {0}", _installRoot),
                Location = new Point(24, 256),
                Size = new Size(472, 20),
                Font = new Font("Segoe UI", 8.25f, FontStyle.Regular),
                ForeColor = Color.FromArgb(100, 116, 139)
            };
            this.Controls.Add(_subStatusLabel);

            _openExtBtn = new Button
            {
                Text = "Copy Extension Path",
                Location = new Point(24, 290),
                Size = new Size(155, 32),
                Visible = false
            };
            _openExtBtn.Click += delegate
            {
                try
                {
                    Clipboard.SetText(_extDir);
                    MessageBox.Show(
                        "Extension folder copied to clipboard:\r\n" + _extDir + "\r\n\r\nIn Chrome/Edge -> Extensions -> Enable Developer Mode -> Load unpacked -> Paste this path.",
                        "OnTrack Browser Extension",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information
                    );
                }
                catch { }
            };
            this.Controls.Add(_openExtBtn);

            _closeBtn = new Button
            {
                Text = "Cancel",
                Location = new Point(286, 290),
                Size = new Size(92, 32)
            };
            _closeBtn.Click += delegate
            {
                if (!_isInstalling) this.Close();
            };
            this.Controls.Add(_closeBtn);

            _installBtn = new Button
            {
                Text = "Install Silently",
                Location = new Point(386, 290),
                Size = new Size(110, 32),
                BackColor = Color.FromArgb(79, 70, 229),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            _installBtn.FlatAppearance.BorderSize = 0;
            _installBtn.Click += delegate { StartGuiInstall(); };
            this.Controls.Add(_installBtn);
            this.AcceptButton = _installBtn;
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            if (string.IsNullOrWhiteSpace(_tokenBox.Text))
            {
                string fileKey = InstallerEngine.TryFindSiblingCredentialsKey();
                if (!string.IsNullOrEmpty(fileKey))
                {
                    _tokenBox.Text = fileKey;
                    _subStatusLabel.Text = "Detected Installation Key from Credentials (.txt). Click Install Silently to continue.";
                    return;
                }
                try
                {
                    if (Clipboard.ContainsText())
                    {
                        string clip = (Clipboard.GetText() ?? "").Trim();
                        if (clip.StartsWith("ontrack_dev_", StringComparison.Ordinal))
                        {
                            _tokenBox.Text = clip;
                            _subStatusLabel.Text = "Detected Installation Key from clipboard. Click Install Silently to continue.";
                        }
                    }
                }
                catch { }
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (_isInstalling)
            {
                e.Cancel = true;
                return;
            }
            if (_deleteBundleOnExit && File.Exists(_bundleZipPath))
            {
                try { File.Delete(_bundleZipPath); } catch { }
            }
            base.OnFormClosing(e);
        }

        private void StartGuiInstall()
        {
            if (_completed)
            {
                this.Close();
                return;
            }
            string token = (_tokenBox.Text ?? "").Trim();
            if (!InstallerEngine.IsValidDeviceToken(token))
            {
                MessageBox.Show(
                    "Please paste a valid OnTrack Installation Key (ontrack_dev_...) from your credentials file.",
                    "Installation Key Required",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning
                );
                _tokenBox.Focus();
                return;
            }

            _isInstalling = true;
            _tokenBox.ReadOnly = true;
            _openBrowserCheck.Enabled = false;
            _installBtn.Enabled = false;
            _closeBtn.Enabled = false;

            bool openExtAfter = _openBrowserCheck.Checked;
            var worker = new Thread(delegate ()
            {
                try
                {
                    InstallerEngine.RunInstall(
                        _meta,
                        _bundleZipPath,
                        _installRoot,
                        _agentDir,
                        _extDir,
                        token,
                        openExtAfter,
                        delegate (int pct, string msg, string detail)
                        {
                            UpdateUiProgress(pct, msg, detail);
                        }
                    );
                    this.BeginInvoke((MethodInvoker)delegate
                    {
                        _isInstalling = false;
                        _completed = true;
                        _progressBar.Value = 100;
                        _openExtBtn.Visible = true;
                        _closeBtn.Visible = false;
                        _installBtn.Text = "Finish";
                        _installBtn.Enabled = true;
                        try { Clipboard.SetText(_extDir); } catch { }
                    });
                }
                catch (Exception ex)
                {
                    this.BeginInvoke((MethodInvoker)delegate
                    {
                        _isInstalling = false;
                        _tokenBox.ReadOnly = false;
                        _openBrowserCheck.Enabled = true;
                        _installBtn.Enabled = true;
                        _closeBtn.Enabled = true;
                        _statusLabel.Text = "Installation failed.";
                        _subStatusLabel.Text = ex.Message;
                        MessageBox.Show(
                            "OnTrack installation could not finish:\r\n\r\n" + ex.Message,
                            "OnTrack Setup Error",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Error
                        );
                    });
                }
            });
            worker.IsBackground = true;
            worker.Start();
        }

        private void UpdateUiProgress(int pct, string msg, string detail)
        {
            if (this.IsDisposed) return;
            try
            {
                this.BeginInvoke((MethodInvoker)delegate
                {
                    _progressBar.Value = Math.Max(0, Math.Min(100, pct));
                    _statusLabel.Text = msg;
                    if (!string.IsNullOrEmpty(detail))
                    {
                        _subStatusLabel.Text = detail;
                    }
                });
            }
            catch { }
        }
    }

    internal static class InstallerEngine
    {
        private static readonly byte[] OverlayMagic = Encoding.ASCII.GetBytes("OTBNDL01");

        public static bool IsValidDeviceToken(string token)
        {
            if (string.IsNullOrWhiteSpace(token)) return false;
            return Regex.IsMatch(token.Trim(), "^[A-Za-z0-9_.\\-]{12,200}$");
        }

        public static string ExtractEmbeddedOrSidecarBundle(out bool deleteOnExit)
        {
            deleteOnExit = false;
            string exePath = Assembly.GetExecutingAssembly().Location;

            // 1. Check trailing overlay appended to the .exe: [ZIP][uint64 LE length]["OTBNDL01"]
            if (File.Exists(exePath))
            {
                using (var fs = new FileStream(exePath, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    if (fs.Length > 16)
                    {
                        fs.Seek(-8, SeekOrigin.End);
                        byte[] magicBuf = new byte[8];
                        fs.Read(magicBuf, 0, 8);
                        bool match = true;
                        for (int i = 0; i < 8; i++)
                        {
                            if (magicBuf[i] != OverlayMagic[i]) { match = false; break; }
                        }
                        if (match)
                        {
                            fs.Seek(-16, SeekOrigin.End);
                            byte[] lenBuf = new byte[8];
                            fs.Read(lenBuf, 0, 8);
                            long zipLen = BitConverter.ToInt64(lenBuf, 0);
                            if (zipLen > 0 && zipLen <= fs.Length - 16)
                            {
                                string tmp = Path.Combine(Path.GetTempPath(), "ontrack-bundle-" + Guid.NewGuid().ToString("N") + ".zip");
                                fs.Seek(fs.Length - 16 - zipLen, SeekOrigin.Begin);
                                CopyExactBytes(fs, tmp, zipLen);
                                deleteOnExit = true;
                                return tmp;
                            }
                        }
                    }
                }
            }

            // 2. Check embedded .NET manifest resource
            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream resStream = asm.GetManifestResourceStream("ontrack-bundle.zip"))
            {
                if (resStream != null)
                {
                    string tmp = Path.Combine(Path.GetTempPath(), "ontrack-bundle-" + Guid.NewGuid().ToString("N") + ".zip");
                    using (var outFs = new FileStream(tmp, FileMode.Create, FileAccess.Write))
                    {
                        resStream.CopyTo(outFs);
                    }
                    deleteOnExit = true;
                    return tmp;
                }
            }

            // 3. Check sidecar bundle next to executable
            string sidecar = Path.Combine(Path.GetDirectoryName(exePath) ?? ".", "ontrack-bundle.zip");
            if (File.Exists(sidecar))
            {
                return sidecar;
            }

            throw new InvalidOperationException("Installer payload (ontrack-bundle.zip) was not found inside this executable.");
        }

        private static void CopyExactBytes(Stream src, string destPath, long count)
        {
            byte[] buf = new byte[81920];
            using (var outFs = new FileStream(destPath, FileMode.Create, FileAccess.Write))
            {
                long remaining = count;
                while (remaining > 0)
                {
                    int toRead = (int)Math.Min(buf.Length, remaining);
                    int read = src.Read(buf, 0, toRead);
                    if (read <= 0) break;
                    outFs.Write(buf, 0, read);
                    remaining -= read;
                }
            }
        }

        public static InstallMeta ReadMetaFromBundle(string zipPath)
        {
            var meta = new InstallMeta();
            using (ZipArchive archive = ZipFile.OpenRead(zipPath))
            {
                ZipArchiveEntry entry = archive.GetEntry("install-meta.json");
                if (entry == null) return meta;
                using (var reader = new StreamReader(entry.Open(), Encoding.UTF8))
                {
                    string json = reader.ReadToEnd();
                    string serverUrl = ExtractJsonString(json, "serverUrl");
                    string tenantId = ExtractJsonString(json, "tenantId");
                    string userId = ExtractJsonString(json, "userId");
                    string secret = ExtractJsonString(json, "bridgeSecret");
                    if (!string.IsNullOrEmpty(serverUrl)) meta.ServerUrl = serverUrl;
                    if (!string.IsNullOrEmpty(tenantId)) meta.TenantId = tenantId;
                    if (!string.IsNullOrEmpty(userId)) meta.UserId = userId;
                    if (!string.IsNullOrEmpty(secret)) meta.BridgeSecret = secret;
                    int port = ExtractJsonInt(json, "bridgePort");
                    if (port > 0) meta.BridgePort = port;
                    int hb = ExtractJsonInt(json, "heartbeatSeconds");
                    if (hb > 0) meta.HeartbeatSeconds = hb;
                    int poll = ExtractJsonInt(json, "pollSampleMs");
                    if (poll > 0) meta.PollSampleMs = poll;
                    int idle = ExtractJsonInt(json, "idleThresholdSeconds");
                    if (idle > 0) meta.IdleThresholdSeconds = idle;
                }
            }
            if (string.IsNullOrEmpty(meta.BridgeSecret))
            {
                meta.BridgeSecret = Guid.NewGuid().ToString("N");
            }
            return meta;
        }

        private static string ExtractJsonString(string json, string key)
        {
            Match m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            if (!m.Success) return "";
            return m.Groups[1].Value.Replace("\\/", "/").Replace("\\\"", "\"").Replace("\\\\", "\\");
        }

        private static int ExtractJsonInt(string json, string key)
        {
            Match m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(\\d+)");
            int val;
            if (m.Success && int.TryParse(m.Groups[1].Value, out val)) return val;
            return 0;
        }

        private static string JsonEscape(string s)
        {
            if (s == null) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
        }

        public static void RunInstall(
            InstallMeta meta,
            string bundleZipPath,
            string installRoot,
            string agentDir,
            string extDir,
            string deviceToken,
            bool openBrowserExtensions,
            Action<int, string, string> progress
        )
        {
            progress(10, "Stopping any previous OnTrack agent...", installRoot);
            StopExistingAgent(installRoot);

            progress(25, "Extracting Desktop Agent & Browser Extension...", "Unpacking files safely to %LOCALAPPDATA%\\OnTrack");
            Directory.CreateDirectory(installRoot);
            Directory.CreateDirectory(agentDir);
            Directory.CreateDirectory(extDir);

            ExtractSubtree(bundleZipPath, "desktop-agent/", agentDir);
            ExtractSubtree(bundleZipPath, "browser-extension/", extDir);

            progress(45, "Writing paired agent & extension configuration...", "Applying device token and authenticated bridge secret");
            string deviceId = "dev-" + (string.IsNullOrEmpty(meta.UserId) ? Environment.MachineName : meta.UserId + "-" + Environment.MachineName);
            string agentConfigJson = "{\n" +
                "  \"serverUrl\": \"" + JsonEscape(meta.ServerUrl) + "\",\n" +
                "  \"tenantId\": \"" + JsonEscape(meta.TenantId) + "\",\n" +
                "  \"userId\": \"" + JsonEscape(meta.UserId) + "\",\n" +
                "  \"deviceId\": \"" + JsonEscape(deviceId) + "\",\n" +
                "  \"deviceToken\": \"" + JsonEscape(deviceToken.Trim()) + "\",\n" +
                "  \"bridgePort\": " + meta.BridgePort + ",\n" +
                "  \"bridgeSecret\": \"" + JsonEscape(meta.BridgeSecret) + "\",\n" +
                "  \"heartbeatSeconds\": " + meta.HeartbeatSeconds + ",\n" +
                "  \"pollSampleMs\": " + meta.PollSampleMs + ",\n" +
                "  \"idleThresholdSeconds\": " + meta.IdleThresholdSeconds + "\n" +
                "}\n";
            File.WriteAllText(Path.Combine(agentDir, "agent.config.json"), agentConfigJson, new UTF8Encoding(false));

            string extConfigJson = "{\n" +
                "  \"bridgeUrl\": \"http://127.0.0.1:" + meta.BridgePort + "/browser-event\",\n" +
                "  \"bridgeSecret\": \"" + JsonEscape(meta.BridgeSecret) + "\",\n" +
                "  \"excludedDomains\": [\"personalbank\", \"mychart\", \"chase.com\"]\n" +
                "}\n";
            File.WriteAllText(Path.Combine(extDir, "config.defaults.json"), extConfigJson, new UTF8Encoding(false));

            progress(60, "Checking Node.js 22+ runtime...", "Looking for Node.js");
            string nodeExe = EnsureNodeJsInstalled(progress);

            progress(72, "Preparing native Windows focus watcher...", "Compiling FocusWatcher.cs with .NET Framework");
            PrecompileFocusWatcher(agentDir, installRoot);

            progress(82, "Registering silent background startup & launching agent...", "Zero console windows");
            CreateSilentLaunchersAndStart(installRoot, agentDir, nodeExe);

            progress(92, "Verifying local Desktop Agent bridge...", "Checking http://127.0.0.1:" + meta.BridgePort + "/health");
            bool healthy = WaitForBridgeHealth(meta.BridgePort, 10000);

            if (openBrowserExtensions)
            {
                LaunchAppSignInBrowser(meta.ServerUrl);
            }

            string summary = healthy
                ? "Desktop Agent LIVE on :" + meta.BridgePort + ". Browser opening OnTrack Sign-In."
                : "Installed to " + installRoot + ". Agent starting up; browser opening OnTrack Sign-In.";
            progress(100, "OnTrack installation complete.", summary);
        }

        private static void StopExistingAgent(string installRoot)
        {
            string pidFile = Path.Combine(installRoot, "agent.pid");
            if (File.Exists(pidFile))
            {
                try
                {
                    int pid;
                    if (int.TryParse(File.ReadAllText(pidFile).Trim(), out pid) && pid > 0)
                    {
                        Process p = Process.GetProcessById(pid);
                        p.Kill();
                        p.WaitForExit(3000);
                    }
                }
                catch { }
                try { File.Delete(pidFile); } catch { }
            }
        }

        private static void ExtractSubtree(string zipPath, string prefix, string destRoot)
        {
            string fullDestRoot = Path.GetFullPath(destRoot);
            if (!fullDestRoot.EndsWith(Path.DirectorySeparatorChar.ToString()))
            {
                fullDestRoot += Path.DirectorySeparatorChar;
            }

            using (ZipArchive archive = ZipFile.OpenRead(zipPath))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string normalizedName = entry.FullName.Replace('\\', '/');
                    if (!normalizedName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
                    string rel = normalizedName.Substring(prefix.Length).TrimStart('/');
                    if (string.IsNullOrEmpty(rel)) continue;

                    string targetPath = Path.GetFullPath(Path.Combine(fullDestRoot, rel.Replace('/', Path.DirectorySeparatorChar)));
                    if (!targetPath.StartsWith(fullDestRoot, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidOperationException("Blocked unsafe archive entry path: " + entry.FullName);
                    }

                    if (normalizedName.EndsWith("/"))
                    {
                        Directory.CreateDirectory(targetPath);
                    }
                    else
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(targetPath));
                        entry.ExtractToFile(targetPath, true);
                    }
                }
            }
        }

        private static string FindNodeExe()
        {
            var candidates = new List<string>();
            string pathEnv = (Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.Process) ?? "") + ";" +
                             (Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.Machine) ?? "") + ";" +
                             (Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.User) ?? "");
            foreach (string dir in pathEnv.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
            {
                candidates.Add(Path.Combine(dir.Trim(), "node.exe"));
            }
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"));
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"));

            foreach (string c in candidates)
            {
                if (File.Exists(c) && CheckNodeMajorVersion(c) >= 22)
                {
                    return c;
                }
            }
            return null;
        }

        private static int CheckNodeMajorVersion(string nodeExe)
        {
            try
            {
                var psi = new ProcessStartInfo(nodeExe, "-v")
                {
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    CreateNoWindow = true
                };
                using (Process p = Process.Start(psi))
                {
                    string outStr = p.StandardOutput.ReadToEnd().Trim();
                    p.WaitForExit(3000);
                    Match m = Regex.Match(outStr, "^v?(\\d+)");
                    int major;
                    if (m.Success && int.TryParse(m.Groups[1].Value, out major)) return major;
                }
            }
            catch { }
            return 0;
        }

        private static string EnsureNodeJsInstalled(Action<int, string, string> progress)
        {
            string existing = FindNodeExe();
            if (existing != null) return existing;

            progress(64, "Installing Node.js LTS silently (first-time setup)...", "Using Windows winget");
            try
            {
                var psi = new ProcessStartInfo(
                    "winget.exe",
                    "install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements"
                )
                {
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                using (Process p = Process.Start(psi))
                {
                    p.WaitForExit(180000);
                }
            }
            catch { }

            existing = FindNodeExe();
            if (existing != null) return existing;

            throw new InvalidOperationException(
                "Node.js 22+ is required to run the Desktop Agent and automatic winget install was unavailable. Install Node.js 22 LTS from https://nodejs.org and re-run setup."
            );
        }

        private static void PrecompileFocusWatcher(string agentDir, string installRoot)
        {
            string csFile = Path.Combine(agentDir, "native", "windows", "FocusWatcher.cs");
            if (!File.Exists(csFile)) return;
            string windir = Environment.GetEnvironmentVariable("WINDIR") ?? "C:\\Windows";
            string csc = Path.Combine(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
            if (!File.Exists(csc)) csc = Path.Combine(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe");
            if (!File.Exists(csc)) return;

            try
            {
                byte[] srcBytes = File.ReadAllBytes(csFile);
                string hashHex;
                using (SHA256 sha = SHA256.Create())
                {
                    byte[] digest = sha.ComputeHash(srcBytes);
                    var sb = new StringBuilder();
                    for (int i = 0; i < digest.Length; i++) sb.Append(digest[i].ToString("x2"));
                    hashHex = sb.ToString().Substring(0, 10);
                }
                string outExe = Path.Combine(installRoot, "ontrack-focus-watcher-" + hashHex + ".exe");
                if (File.Exists(outExe)) return;
                var psi = new ProcessStartInfo(
                    csc,
                    string.Format("/nologo /target:exe /optimize+ /r:System.dll \"/out:{0}\" \"{1}\"", outExe, csFile)
                )
                {
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                using (Process p = Process.Start(psi))
                {
                    p.WaitForExit(30000);
                }
            }
            catch { }
        }

        private static void CreateSilentLaunchersAndStart(string installRoot, string agentDir, string nodeExe)
        {
            string agentEntry = Path.Combine(agentDir, "src", "agent.ts");
            string cmdPath = Path.Combine(agentDir, "start-agent-silent.cmd");
            string cmdBody = "@echo off\r\ncd /d \"" + agentDir + "\"\r\n\"" + nodeExe + "\" --experimental-strip-types \"src\\agent.ts\"\r\n";
            File.WriteAllText(cmdPath, cmdBody, Encoding.ASCII);

            string vbsPath = Path.Combine(agentDir, "launch-agent.vbs");
            string vbsBody =
                "Set shell = CreateObject(\"WScript.Shell\")\r\n" +
                "shell.CurrentDirectory = \"" + agentDir.Replace("\"", "\"\"") + "\"\r\n" +
                "shell.Run \"\"\"" + nodeExe.Replace("\"", "\"\"") + "\"\" --experimental-strip-types \"\"src\\agent.ts\"\"\", 0, False\r\n";
            File.WriteAllText(vbsPath, vbsBody, Encoding.ASCII);

            try
            {
                using (RegistryKey runKey = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run", true))
                {
                    if (runKey != null)
                    {
                        runKey.SetValue("OnTrackDesktopAgent", "wscript.exe \"" + vbsPath + "\"");
                    }
                }
            }
            catch { }

            var startPsi = new ProcessStartInfo(nodeExe, "--experimental-strip-types \"" + agentEntry + "\"")
            {
                WorkingDirectory = agentDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            Process proc = Process.Start(startPsi);
            if (proc != null)
            {
                try { File.WriteAllText(Path.Combine(installRoot, "agent.pid"), proc.Id.ToString(), Encoding.ASCII); } catch { }
            }
        }

        private static bool WaitForBridgeHealth(int port, int timeoutMs)
        {
            Stopwatch sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < timeoutMs)
            {
                try
                {
                    var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/health");
                    req.Timeout = 1000;
                    using (var resp = (HttpWebResponse)req.GetResponse())
                    {
                        if ((int)resp.StatusCode == 200) return true;
                    }
                }
                catch { }
                Thread.Sleep(400);
            }
            return false;
        }

        public static string TryFindSiblingCredentialsKey()
        {
            var dirs = new List<string>();
            try
            {
                string exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                if (!string.IsNullOrEmpty(exeDir)) dirs.Add(exeDir);
            }
            catch { }
            try
            {
                if (!string.IsNullOrEmpty(Environment.CurrentDirectory)) dirs.Add(Environment.CurrentDirectory);
            }
            catch { }

            foreach (string dir in dirs)
            {
                try
                {
                    if (!Directory.Exists(dir)) continue;
                    string[] files = Directory.GetFiles(dir, "OnTrack-Credentials*.txt");
                    foreach (string f in files)
                    {
                        string content = File.ReadAllText(f, Encoding.UTF8);
                        Match m = Regex.Match(content, "Installation Key:\\s*(ontrack_dev_[A-Za-z0-9_.\\-]+)", RegexOptions.IgnoreCase);
                        if (m.Success) return m.Groups[1].Value.Trim();
                    }
                }
                catch { }
            }
            return "";
        }

        private static string BuildAppSignInUrl(string serverUrl)
        {
            string baseUrl = string.IsNullOrWhiteSpace(serverUrl) ? "http://localhost:3000" : serverUrl.Trim().TrimEnd('/');
            if (baseUrl.IndexOf("signin=", StringComparison.OrdinalIgnoreCase) >= 0) return baseUrl;
            return baseUrl + (baseUrl.IndexOf('?') >= 0 ? "&signin=key" : "/?signin=key");
        }

        private static void LaunchAppSignInBrowser(string serverUrl)
        {
            string targetUrl = BuildAppSignInUrl(serverUrl);
            try
            {
                Process.Start(new ProcessStartInfo(targetUrl) { UseShellExecute = true });
                return;
            }
            catch { }

            try
            {
                string chromePath = FindInstalledBrowserExe("chrome.exe");
                if (chromePath != null)
                {
                    Process.Start(new ProcessStartInfo(chromePath, targetUrl) { UseShellExecute = true });
                    return;
                }
                string edgePath = FindInstalledBrowserExe("msedge.exe");
                if (edgePath != null)
                {
                    Process.Start(new ProcessStartInfo(edgePath, targetUrl) { UseShellExecute = true });
                }
            }
            catch { }
        }

        private static string FindInstalledBrowserExe(string exeName)
        {
            string[] roots = new[]
            {
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
            };
            string[] subPaths = exeName == "chrome.exe"
                ? new[] { "Google\\Chrome\\Application\\chrome.exe" }
                : new[] { "Microsoft\\Edge\\Application\\msedge.exe" };
            foreach (string r in roots)
            {
                if (string.IsNullOrEmpty(r)) continue;
                foreach (string sp in subPaths)
                {
                    string candidate = Path.Combine(r, sp);
                    if (File.Exists(candidate)) return candidate;
                }
            }
            return null;
        }
    }

    internal static class Program
    {
        [STAThread]
        public static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            bool deleteOnExit;
            string bundlePath;
            try
            {
                bundlePath = InstallerEngine.ExtractEmbeddedOrSidecarBundle(out deleteOnExit);
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, "OnTrack Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }

            InstallMeta meta = InstallerEngine.ReadMetaFromBundle(bundlePath);
            string cliToken = "";
            bool silent = false;

            foreach (string a in args)
            {
                if (string.Equals(a, "/S", StringComparison.OrdinalIgnoreCase) || string.Equals(a, "--silent", StringComparison.OrdinalIgnoreCase))
                {
                    silent = true;
                }
                else if (a.StartsWith("/Token=", StringComparison.OrdinalIgnoreCase))
                {
                    cliToken = a.Substring(7).Trim();
                }
                else if (a.StartsWith("--token=", StringComparison.OrdinalIgnoreCase))
                {
                    cliToken = a.Substring(8).Trim();
                }
                else if (a.StartsWith("/Key=", StringComparison.OrdinalIgnoreCase))
                {
                    cliToken = a.Substring(5).Trim();
                }
                else if (a.StartsWith("--key=", StringComparison.OrdinalIgnoreCase))
                {
                    cliToken = a.Substring(6).Trim();
                }
            }

            if (silent && InstallerEngine.IsValidDeviceToken(cliToken))
            {
                string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OnTrack");
                try
                {
                    InstallerEngine.RunInstall(
                        meta,
                        bundlePath,
                        root,
                        Path.Combine(root, "Agent"),
                        Path.Combine(root, "Extension"),
                        cliToken,
                        false,
                        delegate { }
                    );
                    return 0;
                }
                catch
                {
                    return 2;
                }
                finally
                {
                    if (deleteOnExit && File.Exists(bundlePath))
                    {
                        try { File.Delete(bundlePath); } catch { }
                    }
                }
            }

            Application.Run(new SetupForm(meta, bundlePath, deleteOnExit, cliToken));
            return 0;
        }
    }
}
