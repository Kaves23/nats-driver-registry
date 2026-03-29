using System;
using System.Drawing;
using System.Windows.Forms;

namespace ROKControl
{
    partial class FormEventPicker
    {
        private Label   lblTitle;
        private ListBox lstEvents;
        private Button  btnOK;
        private Button  btnCancel;

        private void InitializeComponent()
        {
            this.Text       = "Select Event";
            this.ClientSize = new Size(240, 280);
            this.BackColor  = Color.FromArgb(20, 20, 30);

            Font lf = new Font("Tahoma", 8, FontStyle.Regular);
            Font bf = new Font("Tahoma", 9, FontStyle.Bold);

            lblTitle           = new Label();
            lblTitle.Text      = "Select Event";
            lblTitle.Bounds    = new Rectangle(2, 4, 236, 20);
            lblTitle.Font      = bf;
            lblTitle.ForeColor = Color.Yellow;
            this.Controls.Add(lblTitle);

            lstEvents              = new ListBox();
            lstEvents.Bounds       = new Rectangle(2, 28, 236, 196);
            lstEvents.Font         = lf;
            lstEvents.BackColor    = Color.FromArgb(30, 30, 50);
            lstEvents.ForeColor    = Color.White;
            lstEvents.SelectedIndexChanged += lstEvents_SelectedIndexChanged;
            this.Controls.Add(lstEvents);

            btnOK              = new Button();
            btnOK.Text         = "SELECT";
            btnOK.Bounds       = new Rectangle(2, 230, 114, 42);
            btnOK.Font         = bf;
            btnOK.BackColor    = Color.FromArgb(0, 100, 0);
            btnOK.ForeColor    = Color.White;
            btnOK.Click        += btnOK_Click;
            this.Controls.Add(btnOK);

            btnCancel              = new Button();
            btnCancel.Text         = "Skip";
            btnCancel.Bounds       = new Rectangle(124, 230, 114, 42);
            btnCancel.Font         = bf;
            btnCancel.BackColor    = Color.FromArgb(60, 60, 80);
            btnCancel.ForeColor    = Color.White;
            btnCancel.Click        += btnCancel_Click;
            this.Controls.Add(btnCancel);
        }
    }
}
