// TaskDeck - a small personal task tracker.
// A tray app that keeps tasks in tasks.json next to the exe and serves the UI on http://localhost:<port>/.
// The main window is Edge (or Chrome) in "app mode", so it looks like a normal desktop window.
// A global hotkey (Win+Alt+N by default) pops up a native quick-add box from anywhere.
// Pages get changes pushed over /events (server-sent events), so every open window stays in sync.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        bool created;
        using (var mutex = new Mutex(true, "TaskDeck_SingleInstance", out created))
        {
            if (!created)
            {
                // Already running: ask that instance to show its window.
                try { using (var wc = new WebClient()) wc.DownloadString(Settings.Load().Url + "api/show"); } catch { }
                return;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var app = new TrayApp();
            if (!app.Start(args)) return;
            Application.Run();
            app.Stop();
        }
    }
}

// ---------------------------------------------------------------- settings (TaskDeck.ini)

class Settings
{
    public static readonly string BaseDir = AppDomain.CurrentDomain.BaseDirectory;
    public int Port = 8780;
    public string QuickAddHotkey = "Win+Alt+N";
    public string OpenHotkey = "Ctrl+Alt+D";
    public string Browser = "";
    public bool OpenOnStart = true;
    public int FocusMinutes = 25;
    public string KeepAwake = "off"; // off | on | focus - keep-awake mode when TaskDeck starts

    public string Url { get { return "http://localhost:" + Port + "/"; } }

    public static Settings Load()
    {
        var s = new Settings();
        string path = Path.Combine(BaseDir, "TaskDeck.ini");
        if (!File.Exists(path))
        {
            try
            {
                File.WriteAllText(path,
                    "; TaskDeck settings - restart TaskDeck after changing them\r\n" +
                    "; Port of the local server (the app lives on http://localhost:<port>/)\r\nport=8780\r\n" +
                    "; Global hotkeys. Modifiers: Ctrl, Alt, Shift, Win. Leave empty to disable.\r\n" +
                    "; Tip: on Polish/European keyboards Ctrl+Alt = AltGr, so avoid Ctrl+Alt+A/C/E/L/N/O/S/X/Z.\r\n" +
                    "quickadd_hotkey=Win+Alt+N\r\nopen_hotkey=Ctrl+Alt+D\r\n" +
                    "; Open the main window when TaskDeck starts (true/false)\r\nopen_on_start=true\r\n" +
                    "; Length of a focus session in minutes (you get a reminder when it's up)\r\nfocus_minutes=25\r\n" +
                    "; Keep the screen awake (no sleep, no lock) from start: off, on, or focus (only while the focus timer runs)\r\nkeep_awake=off\r\n" +
                    "; Browser used for the app window. Empty = Edge, then Chrome, then your default browser.\r\n" +
                    "; Example: browser=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\r\nbrowser=\r\n");
            }
            catch { }
            return s;
        }
        foreach (string raw in File.ReadAllLines(path))
        {
            string line = raw.Trim();
            int eq = line.IndexOf('=');
            if (line.StartsWith(";") || eq < 0) continue;
            string key = line.Substring(0, eq).Trim().ToLowerInvariant();
            string val = line.Substring(eq + 1).Trim();
            int n;
            if (key == "port" && int.TryParse(val, out n) && n > 0 && n < 65536) s.Port = n;
            else if (key == "quickadd_hotkey") s.QuickAddHotkey = val;
            else if (key == "open_hotkey") s.OpenHotkey = val;
            else if (key == "browser") s.Browser = val;
            else if (key == "open_on_start") s.OpenOnStart = !val.Equals("false", StringComparison.OrdinalIgnoreCase) && val != "0";
            else if (key == "focus_minutes" && int.TryParse(val, out n) && n > 0) s.FocusMinutes = n;
            else if (key == "keep_awake")
            {
                string v = val.ToLowerInvariant();
                s.KeepAwake = v == "on" || v == "true" ? "on" : v == "focus" ? "focus" : "off";
            }
        }
        return s;
    }
}

// ---------------------------------------------------------------- tray, hotkeys, windows

class TrayApp
{
    Settings settings;
    Store store;
    Server server;
    NotifyIcon tray;
    HotkeyWindow hotkeys;
    QuickAddForm quick;
    System.Windows.Forms.Timer ticker;
    ToolStripMenuItem autostartItem, timerItem, awakeMenu;
    readonly SynchronizationContext ui = new WindowsFormsSynchronizationContext();
    readonly KeepAwake awake = new KeepAwake();
    Icon iconNormal, iconAwake;
    string lastFocusNotified;

    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    public bool Start(string[] args)
    {
        settings = Settings.Load();
        store = new Store(Settings.BaseDir);
        try { store.Load(); }
        catch (Exception ex)
        {
            MessageBox.Show("tasks.json could not be read:\n\n" + ex.Message +
                "\n\nFix or remove the file (a backup is in the backups folder) and start TaskDeck again.", "TaskDeck");
            return false;
        }

        server = new Server(settings, store, awake);
        server.ShowRequested += delegate { ui.Post(delegate { ShowMain(null); }, null); };
        server.AwakeRequested += (mode, minutes) => ui.Post(delegate { SetAwake(mode, minutes); }, null);
        server.TimerChanged += delegate { ui.Post(delegate { UpdateAwake(); }, null); };
        try { server.Start(); }
        catch (Exception ex)
        {
            MessageBox.Show("Could not start the local server on port " + settings.Port + ".\n\n" + ex.Message +
                "\n\nIs another program using this port? Change it in TaskDeck.ini (port=" + settings.Port + ").", "TaskDeck");
            return false;
        }

        // Hotkeys first, so the menu shows the ones that actually work. When a combo is taken by another
        // app, fall back to the next free one instead of silently doing nothing.
        hotkeys = new HotkeyWindow();
        var notes = new List<string>();
        settings.QuickAddHotkey = RegisterFirst("Quick add", settings.QuickAddHotkey, ShowQuickAdd, notes,
            "Win+Alt+N", "Ctrl+Shift+Alt+Space", "Win+Shift+N", "Ctrl+Alt+Q");
        settings.OpenHotkey = RegisterFirst("Open", settings.OpenHotkey, () => ShowMain(null), notes,
            "Ctrl+Alt+D", "Win+Alt+D", "Ctrl+Shift+Alt+D");

        var menu = new ContextMenuStrip();
        var open = new ToolStripMenuItem("Open TaskDeck", null, delegate { ShowMain(null); });
        open.Font = new Font(open.Font, FontStyle.Bold);
        if (settings.OpenHotkey != "") open.ShortcutKeyDisplayString = settings.OpenHotkey;
        menu.Items.Add(open);
        var add = new ToolStripMenuItem("Quick add…", null, delegate { ShowQuickAdd(); });
        if (settings.QuickAddHotkey != "") add.ShortcutKeyDisplayString = settings.QuickAddHotkey;
        menu.Items.Add(add);
        timerItem = new ToolStripMenuItem("Stop focus timer", null, delegate { store.StopTimer(); UpdateAwake(); server.Broadcast("changed"); });
        menu.Items.Add(timerItem);
        menu.Items.Add(new ToolStripSeparator());
        awakeMenu = new ToolStripMenuItem("Keep screen awake");
        foreach (var opt in AwakeOptions)
        {
            var o = opt;
            awakeMenu.DropDownItems.Add(new ToolStripMenuItem(o.Item1, null, delegate { SetAwake(o.Item2, o.Item3); }) { Tag = o });
        }
        menu.Items.Add(awakeMenu);
        autostartItem = new ToolStripMenuItem("Start with Windows", null, delegate { ToggleAutostart(); });
        menu.Items.Add(autostartItem);
        menu.Items.Add(new ToolStripMenuItem("Open data folder", null, delegate { try { Process.Start(Settings.BaseDir); } catch { } }));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Exit", null, delegate { Application.Exit(); }));
        menu.Opening += delegate
        {
            autostartItem.Checked = AutostartEnabled();
            var t = store.ActiveTimer();
            timerItem.Visible = t != null;
            if (t != null) timerItem.Text = "Stop focus timer (" + Trim(t.Item1.title, 30) + ")";
            awakeMenu.Text = "Keep screen awake" + awake.ShortLabel();
            awakeMenu.Checked = awake.Mode != "off";
            // timed entries stay unchecked; the submenu title shows the end time instead
            foreach (ToolStripMenuItem item in awakeMenu.DropDownItems)
                item.Checked = ((Tuple<string, string, int>)item.Tag).Item2 == awake.Mode && awake.Mode != "timed";
        };

        iconNormal = Icons.App(false);
        iconAwake = Icons.App(true);
        awake.Set(settings.KeepAwake, 0); // applied by the first Tick() below
        tray = new NotifyIcon { Icon = iconNormal, Text = "TaskDeck", ContextMenuStrip = menu, Visible = true };
        tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) ShowMain(null); };

        quick = new QuickAddForm(store);
        quick.Added += (task, openIt) =>
        {
            server.Broadcast("changed");
            if (openIt) ShowMain(task.id);
            else tray.ShowBalloonTip(1500, "Task added", task.title, ToolTipIcon.None);
        };

        // Once a minute: refresh the tray tooltip and remind when a focus session is up.
        ticker = new System.Windows.Forms.Timer { Interval = 15000 };
        ticker.Tick += delegate { Tick(); };
        ticker.Start();
        Tick();

        bool silent = args.Contains("--background");
        if (settings.OpenOnStart && !silent) ShowMain(null);

        string summary = store.DueSummary();
        if (notes.Count > 0)
            tray.ShowBalloonTip(8000, "TaskDeck hotkeys", string.Join("\n", notes), ToolTipIcon.Warning);
        else if (summary != null)
            tray.ShowBalloonTip(5000, "TaskDeck", summary, ToolTipIcon.Info);
        return true;
    }

    // label, mode, minutes - shared by the tray submenu (the page has the same list in app.js)
    static readonly Tuple<string, string, int>[] AwakeOptions =
    {
        Tuple.Create("Off", "off", 0),
        Tuple.Create("For 1 hour", "timed", 60),
        Tuple.Create("For 2 hours", "timed", 120),
        Tuple.Create("For 4 hours", "timed", 240),
        Tuple.Create("Until I turn it off", "on", 0),
        Tuple.Create("While a focus timer runs", "focus", 0),
    };

    void SetAwake(string mode, int minutes)
    {
        awake.Set(mode, minutes);
        UpdateAwake();
        server.Broadcast("changed");
    }

    // Re-applies the keep-awake request (UI thread only) and swaps the tray icon when it turns on or off.
    void UpdateAwake()
    {
        string before = awake.Mode;
        bool changed = awake.Apply(store.ActiveTimer() != null);
        if (changed && tray != null) tray.Icon = awake.Active ? iconAwake : iconNormal;
        if (changed || before != awake.Mode) server.Broadcast("changed"); // e.g. focus timer started, or a timed period ran out
    }

    public void Stop()
    {
        awake.Set("off", 0);
        awake.Apply(false);
        if (ticker != null) ticker.Stop();
        if (hotkeys != null) hotkeys.Dispose();
        if (tray != null) { tray.Visible = false; tray.Dispose(); }
        if (server != null) server.Stop();
    }

    // Registers the configured hotkey, or the first free fallback. Returns the combo in use ("" when none).
    string RegisterFirst(string what, string wanted, Action action, List<string> notes, params string[] fallbacks)
    {
        if (string.IsNullOrWhiteSpace(wanted)) return ""; // disabled in the ini
        if (hotkeys.Register(wanted, action)) return wanted;
        foreach (var alt in fallbacks)
        {
            if (alt.Equals(wanted, StringComparison.OrdinalIgnoreCase) || !hotkeys.Register(alt, action)) continue;
            notes.Add(wanted + " is used by another app - " + what + " is on " + alt + " instead.");
            return alt;
        }
        notes.Add(what + ": " + wanted + " is used by another app. Pick another in TaskDeck.ini.");
        return "";
    }

    void Tick()
    {
        int open = store.OpenCount();
        var t = store.ActiveTimer();
        string tip = "TaskDeck - " + open + " open task" + (open == 1 ? "" : "s");
        if (t != null)
        {
            var mins = (int)((Store.Now() - t.Item2) / 60000);
            tip = "TaskDeck - focusing " + mins + " min on " + t.Item1.title;
            if (mins >= settings.FocusMinutes && lastFocusNotified != t.Item1.id + t.Item2)
            {
                lastFocusNotified = t.Item1.id + t.Item2;
                tray.ShowBalloonTip(8000, "Focus session done", settings.FocusMinutes + " minutes on \"" + Trim(t.Item1.title, 60) +
                    "\". Take a break - the timer keeps running until you stop it.", ToolTipIcon.Info);
                server.Broadcast("focusdone");
            }
        }
        UpdateAwake();
        if (awake.Active) tip += "\nScreen kept awake" + (awake.Mode == "timed" ? awake.ShortLabel() : "");
        tray.Text = Trim(tip, 63);
    }

    static string Trim(string s, int max) { return s.Length <= max ? s : s.Substring(0, max - 1) + "…"; }

    void ShowQuickAdd()
    {
        quick.Popup();
    }

    // Brings an existing TaskDeck window to the front, or opens a new app window.
    void ShowMain(string taskId)
    {
        if (taskId != null) server.Broadcast("open:" + taskId);
        IntPtr hwnd = WindowFinder.Find("TaskDeck");
        if (hwnd != IntPtr.Zero && server.ClientCount > 0)
        {
            WindowFinder.Activate(hwnd);
            return;
        }
        string url = settings.Url + (taskId != null ? "#task=" + taskId : "");
        string appArgs = "--app=" + url + " --window-size=1360,880";
        var candidates = new List<string>();
        if (settings.Browser != "") candidates.Add(settings.Browser);
        candidates.Add("msedge.exe");
        candidates.Add("chrome.exe");
        foreach (var exe in candidates)
        {
            try { Process.Start(new ProcessStartInfo(exe, appArgs) { UseShellExecute = true }); return; }
            catch { }
        }
        try { Process.Start(url); } catch { }
    }

    bool AutostartEnabled()
    {
        try
        {
            using (var key = Registry.CurrentUser.OpenSubKey(RunKey))
                return key != null && key.GetValue("TaskDeck") != null;
        }
        catch { return false; }
    }

    void ToggleAutostart()
    {
        try
        {
            using (var key = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (AutostartEnabled()) key.DeleteValue("TaskDeck", false);
                else key.SetValue("TaskDeck", "\"" + Application.ExecutablePath + "\" --background");
            }
        }
        catch (Exception ex) { MessageBox.Show("Could not change autostart: " + ex.Message, "TaskDeck"); }
    }
}

// Receives WM_HOTKEY for globally registered shortcuts.
class HotkeyWindow : NativeWindow, IDisposable
{
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    const int WM_HOTKEY = 0x0312;
    readonly Dictionary<int, Action> actions = new Dictionary<int, Action>();
    int nextId = 1;

    public HotkeyWindow() { CreateHandle(new CreateParams()); }

    // "Win+Alt+N" -> RegisterHotKey. Returns false when the text is invalid or the combo is taken.
    public bool Register(string text, Action action)
    {
        if (string.IsNullOrWhiteSpace(text)) return true;
        uint mods = 0x4000; // MOD_NOREPEAT
        Keys key = Keys.None;
        foreach (string part in text.Split('+'))
        {
            string p = part.Trim().ToLowerInvariant();
            if (p == "ctrl" || p == "control") mods |= 2;
            else if (p == "alt") mods |= 1;
            else if (p == "shift") mods |= 4;
            else if (p == "win") mods |= 8;
            else
            {
                if (p.Length == 1 && char.IsDigit(p[0])) p = "D" + p;
                try { key = (Keys)Enum.Parse(typeof(Keys), p, true); } catch { return false; }
            }
        }
        if (key == Keys.None) return false;
        int id = nextId++;
        if (!RegisterHotKey(Handle, id, mods, (uint)key)) return false;
        actions[id] = action;
        return true;
    }

    protected override void WndProc(ref Message m)
    {
        Action a;
        if (m.Msg == WM_HOTKEY && actions.TryGetValue(m.WParam.ToInt32(), out a)) a();
        base.WndProc(ref m);
    }

    public void Dispose()
    {
        foreach (int id in actions.Keys) UnregisterHotKey(Handle, id);
        DestroyHandle();
    }
}

static class WindowFinder
{
    delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);

    // Finds a Chromium window whose title starts with `title` (the app window is titled exactly "TaskDeck").
    public static IntPtr Find(string title)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) =>
        {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(256);
            GetWindowText(h, sb, 256);
            if (!sb.ToString().StartsWith(title)) return true;
            var cls = new StringBuilder(64);
            GetClassName(h, cls, 64);
            if (!cls.ToString().StartsWith("Chrome_WidgetWin")) return true;
            found = h;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    public static void Activate(IntPtr h)
    {
        if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
        SetForegroundWindow(h);
    }
}

// Keeps the display on and the PC from idling into sleep or the lock screen - the same request a
// browser makes while a video plays. Windows ties the request to the calling thread, so Apply() must
// always run on the UI thread (which lives as long as the app).
class KeepAwake
{
    [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
    const uint ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x1, ES_DISPLAY_REQUIRED = 0x2;

    public volatile string Mode = "off"; // off | on | timed | focus
    public long Until;                   // unix ms, for "timed"
    public bool Active { get; private set; }

    public void Set(string mode, int minutes)
    {
        Until = mode == "timed" ? Store.Now() + Math.Max(1, minutes) * 60000L : 0;
        Mode = mode == "on" || mode == "timed" || mode == "focus" ? mode : "off";
    }

    // Returns true when the active state changed.
    public bool Apply(bool focusRunning)
    {
        if (Mode == "timed" && Store.Now() >= Until) Mode = "off";
        bool want = Mode == "on" || Mode == "timed" || (Mode == "focus" && focusRunning);
        SetThreadExecutionState(want ? ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED : ES_CONTINUOUS);
        bool changed = want != Active;
        Active = want;
        return changed;
    }

    public Dictionary<string, object> Info()
    {
        return new Dictionary<string, object> { { "mode", Mode }, { "until", Until }, { "active", Active } };
    }

    // " (until 15:30)", " (on)", " (with focus timer)" or "" - appended to menu and tooltip text.
    public string ShortLabel()
    {
        switch (Mode)
        {
            case "on": return " (on)";
            case "timed": return " (until " + new DateTime(1970, 1, 1).AddMilliseconds(Until).ToLocalTime().ToString("HH:mm") + ")";
            case "focus": return " (with focus timer)";
            default: return "";
        }
    }
}

// ---------------------------------------------------------------- quick-add popup

class QuickAddForm : Form
{
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    static readonly Color Bg = Color.FromArgb(24, 25, 32);
    static readonly Color Fg = Color.FromArgb(236, 237, 243);
    static readonly Color Muted = Color.FromArgb(140, 144, 162);
    static readonly Color Accent = Color.FromArgb(124, 108, 255);

    readonly Store store;
    readonly TextBox box;
    readonly Label preview, hint;
    public event Action<TaskItem, bool> Added;

    public QuickAddForm(Store store)
    {
        this.store = store;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        TopMost = true;
        KeyPreview = true;
        BackColor = Bg;
        Size = new Size(680, 128);
        Padding = new Padding(22, 18, 22, 14);

        box = new TextBox
        {
            BorderStyle = BorderStyle.None, BackColor = Bg, ForeColor = Fg,
            Font = new Font("Segoe UI", 17f), Dock = DockStyle.Top,
        };
        preview = new Label { ForeColor = Accent, Font = new Font("Segoe UI Semibold", 10f), Dock = DockStyle.Top, Height = 30, Padding = new Padding(2, 8, 0, 0), AutoEllipsis = true };
        hint = new Label
        {
            ForeColor = Muted, Font = new Font("Segoe UI", 8.75f), Dock = DockStyle.Bottom, Height = 22, AutoEllipsis = true,
            Text = "#tag   !high   @tomorrow  @fri  @12.10   ~doing   // note      ·      Enter add   ·   Shift+Enter add & open   ·   Esc close",
        };
        Controls.Add(preview);
        Controls.Add(box);
        Controls.Add(hint);

        box.TextChanged += delegate { UpdatePreview(); };
        Deactivate += delegate { Hide(); };
        UpdatePreview();
    }

    protected override CreateParams CreateParams
    {
        get { var cp = base.CreateParams; cp.ClassStyle |= 0x20000; return cp; } // CS_DROPSHADOW
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        try
        {
            int round = 2; // DWMWCP_ROUND (Windows 11; ignored on Windows 10)
            DwmSetWindowAttribute(Handle, 33, ref round, 4);
            int dark = 1;
            DwmSetWindowAttribute(Handle, 20, ref dark, 4);
        }
        catch { }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        using (var b = new SolidBrush(Accent)) e.Graphics.FillRectangle(b, 0, 0, 4, Height);
        using (var p = new Pen(Color.FromArgb(52, 54, 68))) e.Graphics.DrawRectangle(p, 0, 0, Width - 1, Height - 1);
    }

    public void Popup()
    {
        var area = Screen.FromPoint(Cursor.Position).WorkingArea;
        Location = new Point(area.Left + (area.Width - Width) / 2, area.Top + area.Height / 4);
        box.Text = "";
        Show();
        Activate();
        box.Focus();
    }

    void UpdatePreview()
    {
        var p = QuickParser.Parse(box.Text);
        var parts = new List<string>();
        if (p.title != "") parts.Add(p.title);
        if (p.status != "todo") parts.Add("→ " + Store.StatusLabel(p.status));
        if (p.priority > 0) parts.Add(new[] { "", "low", "medium", "high" }[p.priority] + " priority");
        if (p.due != null) parts.Add("due " + QuickParser.Friendly(p.due));
        if (p.tags.Count > 0) parts.Add(string.Join(" ", p.tags.Select(t => "#" + t)));
        if (p.notes != "") parts.Add("+ note");
        preview.Text = box.Text.Trim() == "" ? "What needs doing?" : string.Join("   ·   ", parts);
        preview.ForeColor = box.Text.Trim() == "" ? Muted : Accent;
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Escape) { Hide(); e.Handled = e.SuppressKeyPress = true; return; }
        if (e.KeyCode == Keys.Enter)
        {
            e.Handled = e.SuppressKeyPress = true;
            var p = QuickParser.Parse(box.Text);
            if (p.title == "") return;
            var task = store.Create(p);
            Hide();
            if (Added != null) Added(task, e.Shift);
            return;
        }
        base.OnKeyDown(e);
    }
}

// ---------------------------------------------------------------- data

class LogEntry
{
    public long t;
    public string text;
}

class TaskItem
{
    public string id;
    public string title = "";
    public string status = "todo";       // todo | doing | waiting | done
    public int priority;                 // 0 none, 1 low, 2 medium, 3 high
    public List<string> tags = new List<string>();
    public string due;                   // yyyy-MM-dd or null
    public string notes = "";            // markdown
    public double order;
    public long created, updated, completed;
    public long spent;                   // focus time in seconds
    public bool pinned;
    public List<LogEntry> log = new List<LogEntry>();
}

class TimerState
{
    public string id;
    public long start;
}

class Doc
{
    public int version = 1;
    public List<TaskItem> tasks = new List<TaskItem>();
    public TimerState timer;
}

class Store
{
    public static readonly string[] Statuses = { "todo", "doing", "waiting", "done" };
    public static string StatusLabel(string s)
    {
        switch (s) { case "doing": return "In progress"; case "waiting": return "Waiting"; case "done": return "Done"; default: return "To do"; }
    }

    readonly object sync = new object();
    readonly string baseDir, dataPath;
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    Doc doc = new Doc();
    public int Rev;

    public Store(string baseDir)
    {
        this.baseDir = baseDir;
        dataPath = Path.Combine(baseDir, "tasks.json");
    }

    public static long Now() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; }
    static string NewId() { return Guid.NewGuid().ToString("N").Substring(0, 10); }

    public void Load()
    {
        lock (sync)
        {
            if (!File.Exists(dataPath)) { doc = Welcome(); Save(); return; }
            doc = json.Deserialize<Doc>(File.ReadAllText(dataPath, Encoding.UTF8)) ?? new Doc();
            foreach (var t in doc.tasks)
            {
                if (t.tags == null) t.tags = new List<string>();
                if (t.log == null) t.log = new List<LogEntry>();
                if (t.notes == null) t.notes = "";
                if (Array.IndexOf(Statuses, t.status) < 0) t.status = "todo";
            }
        }
    }

    // Writes tasks.json atomically and keeps one dated copy per day in backups\ (last 14 days).
    void Save()
    {
        string text = json.Serialize(doc);
        string tmp = dataPath + ".tmp";
        File.WriteAllText(tmp, text, new UTF8Encoding(false));
        if (File.Exists(dataPath))
        {
            try
            {
                string dir = Path.Combine(baseDir, "backups");
                Directory.CreateDirectory(dir);
                string daily = Path.Combine(dir, "tasks-" + DateTime.Now.ToString("yyyy-MM-dd") + ".json");
                if (!File.Exists(daily)) File.Copy(dataPath, daily);
                foreach (var old in Directory.GetFiles(dir, "tasks-*.json").OrderByDescending(f => f).Skip(14)) File.Delete(old);
            }
            catch { }
            File.Replace(tmp, dataPath, null);
        }
        else File.Move(tmp, dataPath);
        Rev++;
    }

    public string StateJson(object awake)
    {
        lock (sync)
        {
            return json.Serialize(new Dictionary<string, object>
            {
                { "rev", Rev }, { "tasks", doc.tasks }, { "timer", doc.timer }, { "now", Now() }, { "awake", awake },
            });
        }
    }

    public string Serialize(object o) { return json.Serialize(o); }
    public Dictionary<string, object> ParseObject(string text) { return json.DeserializeObject(text) as Dictionary<string, object>; }

    TaskItem Find(string id) { return doc.tasks.FirstOrDefault(t => t.id == id); }

    public TaskItem Create(QuickParser.Result p)
    {
        lock (sync)
        {
            long now = Now();
            var sameColumn = doc.tasks.Where(x => x.status == p.status).ToList();
            var t = new TaskItem
            {
                id = NewId(), title = p.title, status = p.status, priority = p.priority, tags = p.tags, due = p.due, notes = p.notes,
                created = now, updated = now,
                order = sameColumn.Count == 0 ? 1000 : sameColumn.Min(x => x.order) - 1000, // new tasks go on top
            };
            if (t.status == "done") t.completed = now;
            t.log.Add(new LogEntry { t = now, text = "Created" + (t.status != "todo" ? " in " + StatusLabel(t.status) : "") });
            doc.tasks.Add(t);
            Save();
            return t;
        }
    }

    // Applies the given fields to a task. Unknown fields are ignored.
    public TaskItem Update(string id, Dictionary<string, object> f)
    {
        lock (sync)
        {
            var t = Find(id);
            if (t == null) return null;
            long now = Now();
            object v;
            if (f.TryGetValue("title", out v) && v is string && ((string)v).Trim() != "") t.title = ((string)v).Trim();
            if (f.TryGetValue("notes", out v) && v is string) t.notes = (string)v;
            if (f.TryGetValue("priority", out v) && v is int) t.priority = Math.Max(0, Math.Min(3, (int)v));
            if (f.TryGetValue("pinned", out v) && v is bool) t.pinned = (bool)v;
            if (f.TryGetValue("order", out v) && v != null) t.order = Convert.ToDouble(v, CultureInfo.InvariantCulture);
            if (f.ContainsKey("due"))
            {
                string d = f["due"] as string;
                DateTime parsed;
                t.due = d != null && DateTime.TryParseExact(d, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out parsed) ? d : null;
            }
            if (f.TryGetValue("tags", out v) && v is IList)
                t.tags = ((IList)v).Cast<object>().Select(x => QuickParser.CleanTag(Convert.ToString(x))).Where(x => x != "").Distinct().ToList();
            if (f.TryGetValue("status", out v) && v is string && Array.IndexOf(Statuses, (string)v) >= 0 && t.status != (string)v)
            {
                t.log.Add(new LogEntry { t = now, text = StatusLabel(t.status) + " → " + StatusLabel((string)v) });
                t.status = (string)v;
                t.completed = t.status == "done" ? now : 0;
                if (t.status == "done" && doc.timer != null && doc.timer.id == t.id) StopTimerLocked();
            }
            t.updated = now;
            Save();
            return t;
        }
    }

    public bool Delete(string id)
    {
        lock (sync)
        {
            var t = Find(id);
            if (t == null) return false;
            if (doc.timer != null && doc.timer.id == id) doc.timer = null;
            doc.tasks.Remove(t);
            Save();
            return true;
        }
    }

    // Puts back a full task object (used by "Undo" after a delete).
    public void Restore(string text)
    {
        var t = json.Deserialize<TaskItem>(text);
        if (t == null || string.IsNullOrEmpty(t.id)) throw new Exception("Bad task");
        lock (sync)
        {
            doc.tasks.RemoveAll(x => x.id == t.id);
            if (t.tags == null) t.tags = new List<string>();
            if (t.log == null) t.log = new List<LogEntry>();
            if (t.notes == null) t.notes = "";
            doc.tasks.Add(t);
            Save();
        }
    }

    public void StartTimer(string id)
    {
        lock (sync)
        {
            if (Find(id) == null) return;
            StopTimerLocked();
            doc.timer = new TimerState { id = id, start = Now() };
            var t = Find(id);
            if (t.status == "todo" || t.status == "waiting")
            {
                t.log.Add(new LogEntry { t = Now(), text = StatusLabel(t.status) + " → In progress" });
                t.status = "doing";
            }
            Save();
        }
    }

    public void StopTimer() { lock (sync) { StopTimerLocked(); Save(); } }

    void StopTimerLocked()
    {
        if (doc.timer == null) return;
        var t = Find(doc.timer.id);
        long secs = (Now() - doc.timer.start) / 1000;
        if (t != null && secs > 0)
        {
            t.spent += secs;
            if (secs >= 60) t.log.Add(new LogEntry { t = Now(), text = "Focused " + FormatDuration(secs) });
        }
        doc.timer = null;
    }

    static string FormatDuration(long secs)
    {
        long m = secs / 60;
        return m >= 60 ? (m / 60) + " h " + (m % 60) + " min" : m + " min";
    }

    public Tuple<TaskItem, long> ActiveTimer()
    {
        lock (sync)
        {
            if (doc.timer == null) return null;
            var t = Find(doc.timer.id);
            return t == null ? null : Tuple.Create(t, doc.timer.start);
        }
    }

    public int OpenCount() { lock (sync) return doc.tasks.Count(t => t.status != "done"); }

    public string DueSummary()
    {
        lock (sync)
        {
            string today = DateTime.Today.ToString("yyyy-MM-dd");
            var open = doc.tasks.Where(t => t.status != "done" && t.due != null).ToList();
            int overdue = open.Count(t => string.CompareOrdinal(t.due, today) < 0);
            int dueToday = open.Count(t => t.due == today);
            if (overdue == 0 && dueToday == 0) return null;
            var parts = new List<string>();
            if (dueToday > 0) parts.Add(dueToday + " due today");
            if (overdue > 0) parts.Add(overdue + " overdue");
            return string.Join(", ", parts) + ".";
        }
    }

    // ----- attachments (pasted screenshots, dropped files)

    public string AttachDir { get { return Path.Combine(baseDir, "attachments"); } }

    public string SaveAttachment(string name, byte[] data)
    {
        Directory.CreateDirectory(AttachDir);
        string ext = Path.GetExtension(name ?? "").ToLowerInvariant();
        if (!Regex.IsMatch(ext, @"^\.[a-z0-9]{1,8}$")) ext = ".bin";
        string stem = Regex.Replace(Path.GetFileNameWithoutExtension(name ?? "file"), @"[^\w\-]+", "-").Trim('-');
        if (stem.Length > 40) stem = stem.Substring(0, 40);
        if (stem == "") stem = "file";
        string file = DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + stem + ext;
        File.WriteAllBytes(Path.Combine(AttachDir, file), data);
        return file;
    }

    Doc Welcome()
    {
        long now = Now();
        var d = new Doc();
        Func<string, string, int, string, string, double, TaskItem> mk = (title, status, prio, tags, notes, order) => new TaskItem
        {
            id = NewId(), title = title, status = status, priority = prio, notes = notes, order = order,
            tags = tags == "" ? new List<string>() : tags.Split(' ').ToList(),
            created = now, updated = now, completed = status == "done" ? now : 0,
            log = new List<LogEntry> { new LogEntry { t = now, text = "Created" } },
        };
        d.tasks.Add(mk("Welcome to TaskDeck 👋 - open me", "todo", 2, "start",
            "## Quick add\n" +
            "Type in the bar at the top (or press **Win+Alt+N** anywhere in Windows):\n\n" +
            "`Send the report to Anna #work !high @fri // https://example.com/report`\n\n" +
            "| Token | Meaning |\n|---|---|\n" +
            "| `#tag` | adds a tag |\n| `!`, `!!`, `!!!` or `!low` `!med` `!high` | priority |\n" +
            "| `@today` `@tomorrow` `@fri` `@12.10` `@+3d` `@2026-12-01` | due date |\n" +
            "| `~doing` `~waiting` `~done` | start in another column |\n| `// text` | everything after it becomes the note |\n\n" +
            "## Notes\n" +
            "Every task has its own **Markdown** notes - links, checklists, code, tables:\n\n" +
            "- [x] Paste a screenshot straight into the editor (Ctrl+V)\n" +
            "- [ ] Drop a file on the editor to attach it\n" +
            "- [ ] Click a checkbox in the preview to tick it\n\n" +
            "Links open in your normal browser, and Windows paths like `C:\\Users` or `\\\\server\\share` open in Explorer.\n\n" +
            "## Keys\n" +
            "`N` new task · `/` search · `Ctrl+K` command palette · `B` / `L` board or list · `Esc` close\n", 1000));
        d.tasks.Add(mk("Drag me to In progress", "todo", 0, "start", "", 2000));
        d.tasks.Add(mk("Try the focus timer ⏱", "doing", 1, "start",
            "Open a task and press **Focus**. Time is added to the task, and you get a reminder after 25 minutes (change it in `TaskDeck.ini`).", 1000));
        d.tasks.Add(mk("Install TaskDeck", "done", 0, "", "", 1000));
        return d;
    }
}

// ---------------------------------------------------------------- quick-add syntax

static class QuickParser
{
    public class Result
    {
        public string title = "", status = "todo", due, notes = "";
        public int priority;
        public List<string> tags = new List<string>();
    }

    static readonly string[][] Weekdays =
    {
        new[] { "sun", "sunday", "nd", "niedz", "niedziela" },
        new[] { "mon", "monday", "pon", "poniedzialek", "poniedziałek" },
        new[] { "tue", "tues", "tuesday", "wt", "wtorek" },
        new[] { "wed", "wednesday", "sr", "śr", "sroda", "środa" },
        new[] { "thu", "thur", "thurs", "thursday", "czw", "czwartek" },
        new[] { "fri", "friday", "pt", "piatek", "piątek" },
        new[] { "sat", "saturday", "sob", "sobota" },
    };

    public static string CleanTag(string s)
    {
        return Regex.Replace((s ?? "").Trim().TrimStart('#').ToLowerInvariant(), @"[^\p{L}\p{N}_\-/.]+", "");
    }

    public static Result Parse(string text)
    {
        var r = new Result();
        text = (text ?? "").Trim();
        var m = Regex.Match(text, @"(^|\s)//(\s|$)");
        if (m.Success)
        {
            r.notes = text.Substring(m.Index + m.Length).Trim();
            text = text.Substring(0, m.Index);
        }
        var words = new List<string>();
        foreach (string w in Regex.Split(text, @"\s+"))
        {
            if (w == "") continue;
            string lw = w.ToLowerInvariant();
            if (w.Length > 1 && w[0] == '#' && CleanTag(w) != "") { var tag = CleanTag(w); if (!r.tags.Contains(tag)) r.tags.Add(tag); continue; }
            if (Regex.IsMatch(w, @"^!{1,3}$")) { r.priority = w.Length; continue; }
            if (lw == "!low" || lw == "!1") { r.priority = 1; continue; }
            if (lw == "!med" || lw == "!medium" || lw == "!2") { r.priority = 2; continue; }
            if (lw == "!high" || lw == "!urgent" || lw == "!3") { r.priority = 3; continue; }
            if (lw.Length > 1 && lw[0] == '~')
            {
                string s = lw.Substring(1);
                string st = s == "todo" ? "todo" : (s == "doing" || s == "progress" || s == "wip" || s == "now") ? "doing"
                    : (s == "waiting" || s == "wait" || s == "blocked") ? "waiting" : s == "done" ? "done" : null;
                if (st != null) { r.status = st; continue; }
            }
            if (lw.Length > 1 && lw[0] == '@')
            {
                string d = ParseDate(lw.Substring(1));
                if (d != null) { r.due = d; continue; }
            }
            words.Add(w);
        }
        r.title = string.Join(" ", words);
        return r;
    }

    // today, tomorrow, mon..sun (also Polish), next/nextweek, eow, +3d / 3d / 2w, 2026-10-12, 12.10, 12.10.2026, 12/10
    public static string ParseDate(string s)
    {
        DateTime today = DateTime.Today, d;
        if (s == "today" || s == "tod" || s == "dzis" || s == "dziś") return Fmt(today);
        if (s == "tomorrow" || s == "tmr" || s == "tom" || s == "jutro") return Fmt(today.AddDays(1));
        if (s == "next" || s == "nextweek") return Fmt(today.AddDays(((int)DayOfWeek.Monday - (int)today.DayOfWeek + 7) % 7 == 0 ? 7 : ((int)DayOfWeek.Monday - (int)today.DayOfWeek + 7) % 7));
        if (s == "eow" || s == "weekend") return Fmt(today.AddDays(((int)DayOfWeek.Friday - (int)today.DayOfWeek + 7) % 7));
        if (s == "eom") return Fmt(new DateTime(today.Year, today.Month, DateTime.DaysInMonth(today.Year, today.Month)));
        for (int i = 0; i < 7; i++)
            if (Weekdays[i].Contains(s)) return Fmt(today.AddDays((i - (int)today.DayOfWeek + 7) % 7));
        var m = Regex.Match(s, @"^\+?(\d{1,3})([dwm])$");
        if (m.Success)
        {
            int n = int.Parse(m.Groups[1].Value);
            return Fmt(m.Groups[2].Value == "d" ? today.AddDays(n) : m.Groups[2].Value == "w" ? today.AddDays(7 * n) : today.AddMonths(n));
        }
        if (DateTime.TryParseExact(s, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out d)) return Fmt(d);
        m = Regex.Match(s, @"^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$");
        if (m.Success)
        {
            int day = int.Parse(m.Groups[1].Value), month = int.Parse(m.Groups[2].Value);
            int year = m.Groups[3].Success ? int.Parse(m.Groups[3].Value) : today.Year;
            if (year < 100) year += 2000;
            if (month < 1 || month > 12 || day < 1 || day > DateTime.DaysInMonth(year, month)) return null;
            d = new DateTime(year, month, day);
            if (!m.Groups[3].Success && d < today) d = d.AddYears(1); // "12.01" in October means next January
            return Fmt(d);
        }
        return null;
    }

    static string Fmt(DateTime d) { return d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture); }

    public static string Friendly(string iso)
    {
        DateTime d = DateTime.ParseExact(iso, "yyyy-MM-dd", CultureInfo.InvariantCulture);
        int diff = (int)(d - DateTime.Today).TotalDays;
        if (diff == 0) return "today";
        if (diff == 1) return "tomorrow";
        if (diff > 1 && diff < 7) return d.ToString("dddd", CultureInfo.InvariantCulture);
        return d.ToString("ddd d MMM", CultureInfo.InvariantCulture);
    }
}

// ---------------------------------------------------------------- HTTP server

class Server
{
    const int MaxBody = 30 * 1024 * 1024;

    readonly HttpListener listener = new HttpListener();
    readonly List<HttpListenerResponse> streams = new List<HttpListenerResponse>();
    readonly Settings settings;
    readonly Store store;
    readonly KeepAwake awake;
    public event Action ShowRequested;
    public event Action<string, int> AwakeRequested;
    public event Action TimerChanged;

    static readonly Dictionary<string, string> Pages = new Dictionary<string, string>
    {
        { "/", "index.html" }, { "/app.css", "app.css" }, { "/app.js", "app.js" }, { "/md.js", "md.js" },
    };

    public Server(Settings settings, Store store, KeepAwake awake) { this.settings = settings; this.store = store; this.awake = awake; }

    public int ClientCount { get { lock (streams) return streams.Count; } }

    public void Start()
    {
        listener.Prefixes.Add(settings.Url);
        listener.Start();
        new Thread(AcceptLoop) { IsBackground = true, Name = "http-accept" }.Start();
        new Thread(KeepAlive) { IsBackground = true, Name = "sse-keepalive" }.Start();
    }

    public void Stop() { try { listener.Stop(); listener.Close(); } catch { } }

    void AcceptLoop()
    {
        while (true)
        {
            HttpListenerContext ctx;
            try { ctx = listener.GetContext(); }
            catch { return; }
            ThreadPool.QueueUserWorkItem(delegate { Handle(ctx); });
        }
    }

    void Handle(HttpListenerContext ctx)
    {
        var req = ctx.Request;
        var resp = ctx.Response;
        try
        {
            string path = req.Url.AbsolutePath;
            if (path == "/events") { OpenStream(resp); return; }

            if (path.StartsWith("/api/"))
            {
                // Writes must come from our own page: a custom header can't be sent cross-site without a CORS preflight,
                // which we never approve - so other websites can't poke the local API.
                if (req.HttpMethod == "POST" && req.Headers["X-TaskDeck"] != "1") { Send(resp, 403, "text/plain", "Forbidden"); return; }
                Api(path.Substring(5), req, resp);
                return;
            }
            if (path.StartsWith("/files/"))
            {
                string name = Path.GetFileName(Uri.UnescapeDataString(path.Substring(7)));
                string file = Path.Combine(store.AttachDir, name);
                if (name == "" || !File.Exists(file)) { Send(resp, 404, "text/plain", "Not found"); return; }
                resp.Headers["Content-Disposition"] = "inline; filename=\"" + name.Replace("\"", "") + "\"";
                resp.Headers["X-Content-Type-Options"] = "nosniff";
                Send(resp, 200, MimeType(name), File.ReadAllBytes(file), "max-age=31536000");
                return;
            }

            string page;
            byte[] body = Pages.TryGetValue(path, out page) ? LoadPage(page) : null;
            if (body == null) { Send(resp, 404, "text/plain", "Not found"); return; }
            Send(resp, 200, MimeType(page), body, "no-store");
        }
        catch (Exception ex)
        {
            try { Send(resp, 500, "application/json", Err(ex.Message)); } catch { try { resp.Abort(); } catch { } }
        }
    }

    void Api(string action, HttpListenerRequest req, HttpListenerResponse resp)
    {
        string body = "";
        if (req.HttpMethod == "POST")
        {
            if (req.ContentLength64 > MaxBody) { Send(resp, 413, "application/json", Err("Too large")); return; }
            using (var r = new StreamReader(req.InputStream, Encoding.UTF8)) body = r.ReadToEnd();
        }
        var f = req.HttpMethod == "POST" && body != "" ? store.ParseObject(body) : new Dictionary<string, object>();
        if (f == null) { Send(resp, 400, "application/json", Err("Expected a JSON object")); return; }
        Func<string, string> str = k => { object v; return f.TryGetValue(k, out v) ? v as string : null; };
        string result;

        switch (action)
        {
            case "state":
                result = store.StateJson(awake.Info());
                break;
            case "show":
                if (ShowRequested != null) ShowRequested();
                result = "{\"ok\":true}";
                break;
            case "parse":
                result = store.Serialize(QuickParser.Parse(req.QueryString["text"] ?? ""));
                break;
            case "quick":
            {
                var p = QuickParser.Parse(str("text"));
                if (p.title == "") { Send(resp, 400, "application/json", Err("A task needs a title")); return; }
                string st = str("status");
                if (st != null && Array.IndexOf(Store.Statuses, st) >= 0 && p.status == "todo") p.status = st;
                result = store.Serialize(store.Create(p));
                Broadcast("changed");
                break;
            }
            case "update":
            {
                var t = store.Update(str("id"), f);
                if (t == null) { Send(resp, 404, "application/json", Err("No such task")); return; }
                result = store.Serialize(t);
                if (TimerChanged != null) TimerChanged(); // finishing a task stops its timer
                Broadcast("changed");
                break;
            }
            case "delete":
                store.Delete(str("id"));
                if (TimerChanged != null) TimerChanged();
                result = "{\"ok\":true}";
                Broadcast("changed");
                break;
            case "restore":
                store.Restore(store.Serialize(f["task"]));
                result = "{\"ok\":true}";
                Broadcast("changed");
                break;
            case "timer":
                if (str("action") == "start") store.StartTimer(str("id")); else store.StopTimer();
                if (TimerChanged != null) TimerChanged();
                result = "{\"ok\":true}";
                Broadcast("changed");
                break;
            case "awake":
            {
                object m;
                int minutes = f.TryGetValue("minutes", out m) && m is int ? (int)m : 0;
                if (AwakeRequested != null) AwakeRequested(str("mode") ?? "off", minutes);
                result = "{\"ok\":true}";
                break; // the tray app broadcasts "changed" once the new mode is applied
            }
            case "attach":
            {
                byte[] data = Convert.FromBase64String(str("data") ?? "");
                string file = store.SaveAttachment(str("name"), data);
                result = "{\"url\":" + store.Serialize("/files/" + Uri.EscapeDataString(file)) + "}";
                break;
            }
            case "open":
            {
                string err = OpenTarget(str("target") ?? "");
                result = err == null ? "{\"ok\":true}" : Err(err);
                break;
            }
            case "folder":
                Process.Start(Settings.BaseDir);
                result = "{\"ok\":true}";
                break;
            case "config":
                result = store.Serialize(new Dictionary<string, object>
                {
                    { "quickAddHotkey", settings.QuickAddHotkey }, { "openHotkey", settings.OpenHotkey }, { "focusMinutes", settings.FocusMinutes },
                });
                break;
            default:
                Send(resp, 404, "application/json", Err("Unknown API")); return;
        }
        Send(resp, 200, "application/json; charset=utf-8", result);
    }

    static readonly string[] RiskyExt = { ".exe", ".bat", ".cmd", ".com", ".ps1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".msi", ".msp", ".scr", ".hta", ".reg", ".lnk", ".pif", ".cpl", ".jar" };

    // Opens a link from the notes outside the app: web links in the default browser, folders in Explorer,
    // documents with their app. Programs and scripts are only shown in Explorer, never run.
    string OpenTarget(string target)
    {
        target = target.Trim();
        if (target.StartsWith("/files/")) target = Path.Combine(store.AttachDir, Path.GetFileName(Uri.UnescapeDataString(target.Substring(7))));
        if (Regex.IsMatch(target, @"^(https?:|mailto:)", RegexOptions.IgnoreCase)) { Process.Start(target); return null; }
        if (target.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
        {
            try { target = new Uri(target).LocalPath; } catch { return "Bad file link"; }
        }
        if (!Regex.IsMatch(target, @"^([a-zA-Z]:\\|\\\\)")) return "Only web links and Windows paths can be opened";
        if (Directory.Exists(target)) { Process.Start("explorer.exe", "\"" + target + "\""); return null; }
        if (!File.Exists(target)) return "Not found: " + target;
        if (RiskyExt.Contains(Path.GetExtension(target).ToLowerInvariant())) Process.Start("explorer.exe", "/select,\"" + target + "\"");
        else Process.Start(target);
        return null;
    }

    string Err(string msg) { return "{\"error\":" + store.Serialize(msg) + "}"; }

    static string MimeType(string name)
    {
        switch (Path.GetExtension(name).ToLowerInvariant())
        {
            case ".html": return "text/html; charset=utf-8";
            case ".css": return "text/css; charset=utf-8";
            case ".js": return "text/javascript; charset=utf-8";
            case ".png": return "image/png";
            case ".jpg": case ".jpeg": return "image/jpeg";
            case ".gif": return "image/gif";
            case ".webp": return "image/webp";
            case ".bmp": return "image/bmp";
            case ".pdf": return "application/pdf";
            case ".txt": case ".log": case ".md": case ".csv": return "text/plain; charset=utf-8";
            default: return "application/octet-stream";
        }
    }

    static void Send(HttpListenerResponse resp, int status, string type, string text) { Send(resp, status, type, Encoding.UTF8.GetBytes(text), "no-store"); }

    static void Send(HttpListenerResponse resp, int status, string type, byte[] body, string cache)
    {
        resp.StatusCode = status;
        resp.ContentType = type;
        resp.Headers["Cache-Control"] = cache;
        resp.ContentLength64 = body.Length;
        resp.OutputStream.Write(body, 0, body.Length);
        resp.Close();
    }

    // ---------- server-sent events

    void OpenStream(HttpListenerResponse resp)
    {
        resp.StatusCode = 200;
        resp.ContentType = "text/event-stream";
        resp.Headers["Cache-Control"] = "no-store";
        resp.SendChunked = true;
        if (!Write(resp, "retry: 2000\n\n")) return;
        lock (streams) streams.Add(resp);
    }

    public void Broadcast(string evt)
    {
        string msg = "data: " + evt + "\n\n";
        List<HttpListenerResponse> copy;
        lock (streams) copy = new List<HttpListenerResponse>(streams);
        foreach (var s in copy)
            if (!Write(s, msg)) lock (streams) streams.Remove(s);
    }

    void KeepAlive()
    {
        while (true)
        {
            Thread.Sleep(10000);
            List<HttpListenerResponse> copy;
            lock (streams) copy = new List<HttpListenerResponse>(streams);
            foreach (var s in copy)
                if (!Write(s, ": ping\n\n")) lock (streams) streams.Remove(s);
        }
    }

    static bool Write(HttpListenerResponse resp, string text)
    {
        try
        {
            byte[] b = Encoding.UTF8.GetBytes(text);
            lock (resp)
            {
                resp.OutputStream.Write(b, 0, b.Length);
                resp.OutputStream.Flush();
            }
            return true;
        }
        catch
        {
            try { resp.Abort(); } catch { }
            return false;
        }
    }

    // Pages are embedded in the exe; a copy in web\ next to the exe wins, so they can be tweaked without rebuilding.
    static byte[] LoadPage(string name)
    {
        string disk = Path.Combine(Path.Combine(Settings.BaseDir, "web"), name);
        if (File.Exists(disk)) return File.ReadAllBytes(disk);
        using (Stream res = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
        {
            if (res == null) return null;
            var ms = new MemoryStream();
            res.CopyTo(ms);
            return ms.ToArray();
        }
    }
}

// ---------------------------------------------------------------- icon

static class Icons
{
    // A rounded violet square with a white check mark, drawn at runtime so the exe needs no .ico file.
    // `awake` adds an amber dot in the corner while the screen is being kept awake.
    public static Icon App(bool awake)
    {
        using (var bmp = new Bitmap(32, 32))
        {
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (var path = Rounded(new RectangleF(1, 1, 30, 30), 8))
                using (var b = new LinearGradientBrush(new PointF(0, 0), new PointF(32, 32), Color.FromArgb(139, 124, 255), Color.FromArgb(92, 72, 230)))
                    g.FillPath(b, path);
                using (var p = new Pen(Color.White, 3.6f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
                    g.DrawLines(p, new[] { new PointF(9, 16.5f), new PointF(14, 21.5f), new PointF(23, 11) });
                if (awake)
                {
                    using (var ring = new SolidBrush(Color.FromArgb(24, 25, 32))) g.FillEllipse(ring, 19, 19, 13, 13);
                    using (var dot = new SolidBrush(Color.FromArgb(242, 169, 59))) g.FillEllipse(dot, 21, 21, 9, 9);
                }
            }
            return Icon.FromHandle(bmp.GetHicon());
        }
    }

    static GraphicsPath Rounded(RectangleF r, float rad)
    {
        var p = new GraphicsPath();
        float d = rad * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }
}
