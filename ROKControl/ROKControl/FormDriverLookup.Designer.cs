using System;
using System.Drawing;
using System.Windows.Forms;

namespace ROKControl
{
    partial class FormDriverLookup
    {
        private Label   lblTitle;
        private Label   lblSearch;
        private TextBox txtFilter;
        private ListBox lstDrivers;
        private Label   lblCount;
        private Button  btnRefresh;
        private Button  btnSelect;
        private Button  btnCancel;

        private void InitializeComponent()
        {
            this.Text       = "Select Driver";
            this.ClientSize = new Size(240, 320);
            this.BackColor  = Color.FromArgb(20, 20, 30);

            Font lf = new Font("Tahoma", 8, FontStyle.Regular);
            Font bf = new Font("Tahoma", 9, FontStyle.Bold);

            lblTitle       = new Label();
            lblTitle.Text  = "Driver Lookup";
            lblTitle.Bounds = new Rectangle(2, 4, 236, 20);
            lblTitle.Font  = bf;
            lblTitle.ForeColor = Color.Yellow;
            this.Controls.Add(lblTitle);

            lblSearch      = new Label();
            lblSearch.Text = "Search (name/number):";
            lblSearch.Bounds = new Rectangle(2, 28, 236, 16);
            lblSearch.Font = lf;
            lblSearch.ForeColor = Color.LightGray;
            this.Controls.Add(lblSearch);

            txtFilter      = new TextBox();
            txtFilter.Bounds = new Rectangle(2, 46, 236, 22);
            txtFilter.Font = lf;
            txtFilter.BackColor = Color.FromArgb(40, 40, 60);
            txtFilter.ForeColor = Color.White;
            txtFilter.TextChanged += txtFilter_TextChanged;
            txtFilter.KeyPress += txtFilter_KeyPress;
            this.Controls.Add(txtFilter);

            lstDrivers     = new ListBox();
            lstDrivers.Bounds = new Rectangle(2, 72, 236, 156);
            lstDrivers.Font = lf;
            lstDrivers.BackColor = Color.FromArgb(30, 30, 50);
            lstDrivers.ForeColor = Color.White;
            lstDrivers.SelectedIndexChanged += lstDrivers_SelectedIndexChanged;
            lstDrivers.DoubleClick += lstDrivers_DoubleClick;
            this.Controls.Add(lstDrivers);

            lblCount       = new Label();
            lblCount.Bounds = new Rectangle(2, 232, 156, 16);
            lblCount.Font  = lf;
            lblCount.ForeColor = Color.Gray;
            lblCount.Text  = "Loading...";
            this.Controls.Add(lblCount);

            btnRefresh     = new Button();
            btnRefresh.Text = "Refresh";
            btnRefresh.Bounds = new Rectangle(160, 228, 78, 22);
            btnRefresh.Font = lf;
            btnRefresh.BackColor = Color.FromArgb(0, 80, 130);
            btnRefresh.ForeColor = Color.White;
            btnRefresh.Click += btnRefresh_Click;
            this.Controls.Add(btnRefresh);

            btnSelect      = new Button();
            btnSelect.Text = "SELECT";
            btnSelect.Bounds = new Rectangle(2, 254, 114, 56);
            btnSelect.Font = bf;
            btnSelect.BackColor = Color.FromArgb(0, 100, 0);
            btnSelect.ForeColor = Color.White;
            btnSelect.Click += btnSelect_Click;
            this.Controls.Add(btnSelect);

            btnCancel      = new Button();
            btnCancel.Text = "Cancel";
            btnCancel.Bounds = new Rectangle(124, 254, 114, 56);
            btnCancel.Font = bf;
            btnCancel.BackColor = Color.FromArgb(100, 0, 0);
            btnCancel.ForeColor = Color.White;
            btnCancel.Click += btnCancel_Click;
            this.Controls.Add(btnCancel);
        }
    }
}
