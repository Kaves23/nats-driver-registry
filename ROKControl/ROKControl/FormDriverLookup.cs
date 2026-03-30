using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace ROKControl
{
    /// <summary>
    /// Driver lookup form.
    ///
    /// Priority: 1) server-fetched entries for the selected event
    ///           2) cached drivers.csv on device (written after each successful server fetch)
    ///
    /// A "Refresh" button re-fetches from the server and shows new/removed entries.
    /// </summary>
    public partial class FormDriverLookup : Form
    {
        public string SelectedVehicleNumber { get; private set; }
        public string SelectedDriverName    { get; private set; }
        public string SelectedClass         { get; private set; }

        // Master list — always stores ALL entries (server or CSV)
        private List<string[]> _drivers = new List<string[]>();
        private readonly AppConfig _config;

        public FormDriverLookup(AppConfig config)
        {
            _config = config;
            InitializeComponent();
            // Try server first; fall back to CSV
            if (_config.EventId > 0)
                FetchFromServer(showNewOnly: false);
            else
                LoadFromCsv();
        }

        // Compatibility overload (ignored server list param)
        public FormDriverLookup(AppConfig config, List<DriverEntry> ignored)
            : this(config) { }

        // ── Server fetch ──────────────────────────────────────────────────

        private void FetchFromServer(bool showNewOnly)
        {
            lblCount.Text = "Fetching from server...";
            btnRefresh.Enabled = false;

            List<string[]> previousDrivers = new List<string[]>(_drivers);

            ThreadPool.QueueUserWorkItem(delegate
            {
                ServerSync sync = new ServerSync(_config);
                List<DriverEntry> entries = sync.FetchDriversForEvent(_config.EventId);

                this.Invoke(new MethodInvoker(delegate
                {
                    btnRefresh.Enabled = true;

                    if (entries == null)
                    {
                        // Server unreachable — fall back to CSV
                        if (_drivers.Count == 0)
                            LoadFromCsv();
                        lblCount.Text = _drivers.Count + " drivers (server unavailable, using cache)";
                        return;
                    }

                    // Build new driver array list
                    List<string[]> newList = new List<string[]>();
                    foreach (DriverEntry e in entries)
                        newList.Add(new string[] { e.VehicleNumber, e.DriverName, e.ClassName });

                    if (showNewOnly)
                    {
                        // Find entries that weren't in the previous list
                        List<string[]> added = new List<string[]>();
                        foreach (string[] n in newList)
                        {
                            bool found = false;
                            foreach (string[] p in previousDrivers)
                            {
                                if (p[0].Trim() == n[0].Trim() && p[1].Trim() == n[1].Trim())
                                { found = true; break; }
                            }
                            if (!found) added.Add(n);
                        }

                        if (added.Count == 0)
                        {
                            lblCount.Text = newList.Count + " drivers (no new entries since last refresh)";
                        }
                        else
                        {
                            lblCount.Text = newList.Count + " drivers (" + added.Count + " NEW)";
                        }
                    }
                    else
                    {
                        lblCount.Text = newList.Count + " drivers (live from server)";
                    }

                    _drivers = newList;
                    SaveToCsv(_drivers);
                    ApplyFilter(txtFilter.Text);
                }));
            });
        }

        // ── CSV fallback ──────────────────────────────────────────────────

        private void LoadFromCsv()
        {
            string csvPath = Path.Combine(AppConfig.ConfigDir, "drivers.csv");
            _drivers.Clear();

            if (File.Exists(csvPath))
            {
                try
                {
                    List<string> lineList = new List<string>();
                    using (StreamReader sr = new StreamReader(csvPath, System.Text.Encoding.UTF8))
                    { string ln; while ((ln = sr.ReadLine()) != null) lineList.Add(ln); }
                    foreach (string line in lineList)
                    {
                        if (string.IsNullOrEmpty(line)) continue;
                        string[] parts = line.Split(',');
                        if (parts.Length < 2) continue;
                        _drivers.Add(parts);
                    }
                }
                catch { }
            }

            lblCount.Text = _drivers.Count + " drivers (CSV backup)";
            ApplyFilter(txtFilter.Text);
        }

        private void SaveToCsv(List<string[]> list)
        {
            try
            {
                if (!Directory.Exists(AppConfig.ConfigDir))
                    Directory.CreateDirectory(AppConfig.ConfigDir);
                string csvPath = Path.Combine(AppConfig.ConfigDir, "drivers.csv");
                System.Text.StringBuilder sb = new System.Text.StringBuilder();
                foreach (string[] d in list)
                    sb.AppendLine(string.Join(",", d));
                File.WriteAllText(csvPath, sb.ToString(), System.Text.Encoding.UTF8);
            }
            catch { }
        }

        // ── List display ──────────────────────────────────────────────────

        private void ApplyFilter(string filter)
        {
            lstDrivers.Items.Clear();
            filter = (filter ?? string.Empty).ToLower();
            foreach (string[] d in _drivers)
            {
                string combined = string.Join(" ", d).ToLower();
                if (string.IsNullOrEmpty(filter) || combined.Contains(filter))
                {
                    string display = d[0].Trim();
                    if (d.Length >= 2) display += "  " + d[1].Trim();
                    if (d.Length >= 3) display += "  [" + d[2].Trim() + "]";
                    lstDrivers.Items.Add(display);
                }
            }
        }

        // ── Event handlers ────────────────────────────────────────────────

        private void txtFilter_TextChanged(object sender, EventArgs e)
        {
            ApplyFilter(txtFilter.Text);
        }

        private void txtFilter_KeyPress(object sender, KeyPressEventArgs e)
        {
            if (e.KeyChar == '\r' || e.KeyChar == '\n')
            {
                if (lstDrivers.Items.Count > 0)
                    lstDrivers.SelectedIndex = 0;
                e.Handled = true;
            }
        }

        private void lstDrivers_DoubleClick(object sender, EventArgs e)
        {
            btnSelect_Click(sender, e);
        }

        private void lstDrivers_SelectedIndexChanged(object sender, EventArgs e)
        {
            if (lstDrivers.SelectedIndex < 0) return;
            string selected = lstDrivers.Items[lstDrivers.SelectedIndex].ToString();
            foreach (string[] d in _drivers)
            {
                string combined = d[0].Trim();
                if (d.Length >= 2) combined += "  " + d[1].Trim();
                if (d.Length >= 3) combined += "  [" + d[2].Trim() + "]";
                if (combined == selected)
                {
                    SelectedVehicleNumber = d[0].Trim();
                    SelectedDriverName    = d.Length >= 2 ? d[1].Trim() : string.Empty;
                    SelectedClass         = d.Length >= 3 ? d[2].Trim() : string.Empty;
                    break;
                }
            }
        }

        private void btnRefresh_Click(object sender, EventArgs e)
        {
            if (_config.EventId <= 0)
            {
                MessageBox.Show("No event selected. Use Menu > Select Event first.", "Refresh");
                return;
            }
            FetchFromServer(showNewOnly: true);
        }

        private void btnSelect_Click(object sender, EventArgs e)
        {
            if (lstDrivers.SelectedIndex < 0 && string.IsNullOrEmpty(SelectedVehicleNumber))
            {
                SelectedVehicleNumber = txtFilter.Text.Trim();
                SelectedDriverName    = string.Empty;
                SelectedClass         = string.Empty;
            }

            if (!string.IsNullOrEmpty(SelectedVehicleNumber))
            {
                this.DialogResult = DialogResult.OK;
                this.Close();
            }
            else
            {
                MessageBox.Show("Enter or select a driver.", "Select Driver");
            }
        }

        private void btnCancel_Click(object sender, EventArgs e)
        {
            this.DialogResult = DialogResult.Cancel;
            this.Close();
        }
    }
}
