using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;

namespace ROKControl
{
    /// <summary>
    /// Displays a list of events fetched from the server.
    /// User taps one to select it; result stored in SelectedEvent.
    /// </summary>
    public partial class FormEventPicker : Form
    {
        public EventRecord SelectedEvent { get; private set; }

        private List<EventRecord> _events;

        public FormEventPicker(List<EventRecord> events)
        {
            _events = events;
            InitializeComponent();
            PopulateList();
        }

        private void PopulateList()
        {
            lstEvents.Items.Clear();
            foreach (EventRecord ev in _events)
                lstEvents.Items.Add(ev);
        }

        private void lstEvents_SelectedIndexChanged(object sender, EventArgs e)
        {
            if (lstEvents.SelectedIndex >= 0)
                SelectedEvent = _events[lstEvents.SelectedIndex];
        }

        private void btnOK_Click(object sender, EventArgs e)
        {
            if (SelectedEvent == null && lstEvents.SelectedIndex >= 0)
                SelectedEvent = _events[lstEvents.SelectedIndex];

            if (SelectedEvent == null)
            {
                MessageBox.Show("Please select an event.", "Select Event");
                return;
            }
            this.DialogResult = DialogResult.OK;
            this.Close();
        }

        private void btnCancel_Click(object sender, EventArgs e)
        {
            this.DialogResult = DialogResult.Cancel;
            this.Close();
        }
    }
}
