using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace ROKControl
{
    /// <summary>
    /// Driver / vehicle lookup form.
    ///
    /// Reads a drivers CSV from \My Documents\ROKControl\drivers.csv
    /// Format: VehicleNo,DriverName,Class  (one per line, no header required)
    ///
    /// If the file is not present the user can type in manually.
    /// </summary>
    public partial class FormDriverLookup : Form
    {
        public string SelectedVehicleNumber { get; private set; }
        public string SelectedDriverName    { get; private set; }
        public string SelectedClass         { get; private set; }

        private List<string[]> _drivers = new List<string[]>();
        private readonly AppConfig _config;

        public FormDriverLookup(AppConfig config)
        {
            _config = config;
            InitializeComponent();
            LoadDriverList();
        }

        // Compatibility overload: old FormMain passed a server driver list; ignored here
        public FormDriverLookup(AppConfig config, List<DriverEntry> ignored)
            : this(config) { }

        private void LoadDriverList()
        {
            string csvPath = Path.Combine(AppConfig.ConfigDir, "drivers.csv");
            lstDrivers.Items.Clear();
            _drivers.Clear();

            if (File.Exists(csvPath))
            {
                try
                {
                    List<string> lineList = new List<string>();
                    using (System.IO.StreamReader sr = new System.IO.StreamReader(csvPath, System.Text.Encoding.UTF8))
                    { string ln; while ((ln = sr.ReadLine()) != null) lineList.Add(ln); }
                    string[] lines = lineList.ToArray();
                    foreach (string line in lines)
                    {
                        if (string.IsNullOrEmpty(line)) continue;
                        string[] parts = line.Split(',');
                        if (parts.Length < 2) continue;
                        _drivers.Add(parts);
                        string display = parts[0].Trim();
                        if (parts.Length >= 2) display += "  " + parts[1].Trim();
                        if (parts.Length >= 3) display += "  [" + parts[2].Trim() + "]";
                        lstDrivers.Items.Add(display);
                    }
                }
                catch { }
            }

            lblCount.Text = _drivers.Count + " drivers loaded";
        }

        private void FilterList(string filter)
        {
            lstDrivers.Items.Clear();
            filter = filter.ToLower();
            for (int i = 0; i < _drivers.Count; i++)
            {
                string[] d = _drivers[i];
                string combined = string.Join(" ", d).ToLower();
                if (combined.Contains(filter))
                {
                    string display = d[0].Trim();
                    if (d.Length >= 2) display += "  " + d[1].Trim();
                    if (d.Length >= 3) display += "  [" + d[2].Trim() + "]";
                    lstDrivers.Items.Add(display);
                }
            }
        }

        private void txtFilter_TextChanged(object sender, EventArgs e)
        {
            FilterList(txtFilter.Text);
        }

        private void txtFilter_KeyPress(object sender, KeyPressEventArgs e)
        {
            // Enter key selects top match immediately
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
            // Find matching driver record
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

        private void btnSelect_Click(object sender, EventArgs e)
        {
            if (lstDrivers.SelectedIndex < 0 && string.IsNullOrEmpty(SelectedVehicleNumber))
            {
                // Manual entry fallback
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
                MessageBox.Show("Enter or select a vehicle number.", "Select Driver");
            }
        }

        private void btnCancel_Click(object sender, EventArgs e)
        {
            this.DialogResult = DialogResult.Cancel;
            this.Close();
        }
    }
}
