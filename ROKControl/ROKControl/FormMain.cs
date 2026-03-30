using System;
using System.Drawing;
using System.Windows.Forms;
using System.Threading;

namespace ROKControl
{
#if WM_DEVICE
    delegate void MethodInvoker();
#endif

    public partial class FormMain : Form
    {
        // ---- State -------------------------------------------------------
        private AppConfig _config;
        private ScannerHelper _scanner;
        private ControlRecord _currentRecord;
        private int _nextSlot = 0;
        private bool _sendPending = false;  // true while a live send is in-flight
#if WM_DEVICE
        private TextBox _captureBox;        // hidden input capture for barcode wedge
#endif

        // Constants
        private const int SLOT_COUNT = 11;   // designer creates 11 panels; we use only slot 0
        private static readonly string[] DEFAULT_TITLES = new string[]
        {
            "Engine Serial", "", "",
            "", "",
            "", "", "", "", "", ""
        };

        // ROK brand colours
        private static readonly Color COL_BG         = Color.FromArgb(20, 20, 30);
        private static readonly Color COL_HEADER     = Color.FromArgb(180, 0, 0);
        private static readonly Color COL_SCAN_WAIT  = Color.FromArgb(40, 40, 55);
        private static readonly Color COL_SCAN_DONE  = Color.FromArgb(0, 100, 0);
        private static readonly Color COL_TEXT       = Color.White;
        private static readonly Color COL_STATUS_BAR = Color.FromArgb(30, 30, 45);

        // ---- Constructor -------------------------------------------------
        public FormMain()
        {
            _config  = AppConfig.Load();
            _scanner = new ScannerHelper();
            _scanner.ScanReceived += OnScanReceived;

            InitializeComponent();

            this.BackColor = COL_BG;
            ApplyBranding();

            // Registration mode: only slot 0 (Engine Serial) is active — hide the rest
            for (int i = 1; i < SLOT_COUNT; i++)
                _slotPanels[i].Visible = false;
            pnlSlots.Height = 36;  // just one row visible

            // Expand status bar upward to fill freed space
            pnlSlots.Bounds  = new Rectangle(0, 90, 480, 36);
            pnlStatus.Bounds = new Rectangle(0, 126, 480, 22);
            pnlButtons.Bounds = new Rectangle(0, 148, 480, 76);

            ResetForm();
            UpdateClock(null, null);

            // Fetch events from server in background; show picker if no event selected yet
            ThreadPool.QueueUserWorkItem(delegate
            {
                ServerSync sync = new ServerSync(_config);
                System.Collections.Generic.List<EventRecord> events = sync.FetchEvents();
                this.Invoke(new MethodInvoker(delegate
                {
                    if (events != null && events.Count > 0)
                    {
                        if (_config.EventId == 0)
                            ShowEventPicker(events);
                        else
                            lblStatus.Text = "Event: " + _config.EventName;
                    }
                    else
                    {
                        string err = sync.LastError;
                        lblStatus.Text = _config.EventId == 0
                            ? (err != null ? "Fetch failed: " + err : "No event set -- use menu to select.")
                            : "Event: " + _config.EventName;
                    }
                }));
            });

            // Wire slot panel tap-to-select
            for (int i = 0; i < SLOT_COUNT; i++)
            {
                int idx = i; // capture for closure
                _slotPanels[i].Click += delegate(object s, EventArgs e2)
                {
                    _nextSlot = idx;
                    HighlightActiveSlot();
                    lblStatus.Text = "Scan for: " + GetSlotTitle(idx);
#if WM_DEVICE
                    _captureBox.Focus();
#endif
                };
            }

#if WM_DEVICE
            // Hidden 1x1 capture TextBox — most reliable way to receive
            // barcode keyboard-wedge input on Windows Mobile regardless of
            // which visible control has focus.
            pnlManual.Visible = false;      // hide desktop test bar on device
            _captureBox = new TextBox();
            _captureBox.Bounds = new Rectangle(0, 0, 1, 1);
            _captureBox.BackColor = COL_BG;
            _captureBox.ForeColor = COL_BG;
            this.Controls.Add(_captureBox);
            _captureBox.KeyPress += delegate(object s, KeyPressEventArgs e2)
            {
                _scanner.FeedKey(e2.KeyChar);
                e2.Handled = true;
            };
            this.Activated += delegate(object s, EventArgs e2) { _captureBox.Focus(); };
#else
            // Desktop: wire manual entry textbox
            txtManualEntry.KeyPress += txtManualEntry_KeyPress;
#endif
        }

        // ---- Scan handler ------------------------------------------------

        private void OnScanReceived(object sender, ScanEventArgs e)
        {
            // Marshal back to UI thread
            if (this.InvokeRequired)
            {
                this.Invoke(new EventHandler<ScanEventArgs>(OnScanReceived), sender, e);
                return;
            }

            HandleCode(e.Code, e.IsRfid);
        }

        private void HandleCode(string code, bool isRfid)
        {
            if (_currentRecord == null)
                StartNewRecord();

            // Slot 0 only: Engine Serial
            if (_nextSlot > 0)
            {
                // Already have engine serial — ignore further scans until reset
                lblStatus.Text = "Engine serial already scanned. Press CLEAR for next driver.";
                return;
            }

            // Slot 0: engine serial
            ScanItem item = new ScanItem
            {
                SlotIndex = 1,
                Title     = "Engine Serial",
                Code      = code,
                IsRfid    = isRfid,
                ScannedAt = DateTime.Now
            };
            _currentRecord.Items.Add(item);
            SetSlotDone(0, code);
            _nextSlot = 1;
            HighlightActiveSlot();
            lblStatus.Text = "Engine: " + code;

            // Auto-send if driver already selected
            if (!string.IsNullOrEmpty(_currentRecord.VehicleNumber))
                AutoSendRegistration(_currentRecord.VehicleNumber, code);
            else
                lblStatus.Text = "Engine " + code + " — select driver to send.";
        }

        private void AutoSendRegistration(string vehicleNumber, string engineSerial)
        {
            if (_sendPending) return;
            _sendPending = true;
            lblStatus.Text     = "Sending...";
            lblStatus.ForeColor = Color.Yellow;

            ThreadPool.QueueUserWorkItem(delegate
            {
                ServerSync      sync   = new ServerSync(_config);
                RegistrationResult result = sync.SendRegistration(vehicleNumber, engineSerial);

                this.Invoke(new MethodInvoker(delegate
                {
                    _sendPending = false;
                    if (result.Success)
                    {
                        lblStatus.Text      = "REGISTERED: " + result.Message;
                        lblStatus.ForeColor = Color.Lime;
                        // Auto-advance to next driver after 1.5 s
#if WM_DEVICE
                        System.Threading.Timer t = null;
                        t = new System.Threading.Timer(delegate
                        {
                            t.Dispose();
                            this.Invoke(new MethodInvoker(AdvanceToNextDriver));
                        }, null, 1500, System.Threading.Timeout.Infinite);
#else
                        System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
                        t.Interval = 1500;
                        t.Tick += delegate { t.Stop(); t.Dispose(); AdvanceToNextDriver(); };
                        t.Start();
#endif
                    }
                    else
                    {
                        lblStatus.Text      = "FAILED: " + result.Message;
                        lblStatus.ForeColor = Color.Red;
                    }
                }));
            });
        }



        // ---- Button handlers ---------------------------------------------

        private void btnPassToNext_Click(object sender, EventArgs e)
        {
            PassToNext();
            this.Focus();
#if WM_DEVICE
            _captureBox.Focus();
#endif
        }

        private void btnRemoveLast_Click(object sender, EventArgs e)
        {
            if (_currentRecord == null || _nextSlot == 0) return;
            _nextSlot--;
            if (_nextSlot < _currentRecord.Items.Count)
                _currentRecord.Items.RemoveAt(_nextSlot);
            ClearSlot(_nextSlot);
            HighlightActiveSlot();
            lblStatus.Text = string.Format("Slot {0} removed.", _nextSlot + 1);
            this.Focus();
#if WM_DEVICE
            _captureBox.Focus();
#endif
        }

        private void btnSendLive_Click(object sender, EventArgs e)
        {
            // RETRY: re-send the current engine serial if a send failed
            if (_currentRecord == null || _currentRecord.Items.Count == 0
                || string.IsNullOrEmpty(_currentRecord.VehicleNumber))
            {
                lblStatus.Text = "Nothing to retry.";
                return;
            }
            string eng = _currentRecord.Items[0].Code;
            AutoSendRegistration(_currentRecord.VehicleNumber, eng);
        }

        private void btnMain_Click(object sender, EventArgs e)
        {
            // CLEAR: discard current and start fresh for next driver
            ResetForm();
            lblStatus.Text = "Cleared. Select next driver.";
#if WM_DEVICE
            _captureBox.Focus();
#endif
        }



        // Manual entry box — for desktop testing without physical scanner
        private void txtManualEntry_KeyPress(object sender, KeyPressEventArgs e)
        {
            if (e.KeyChar == '\r' || e.KeyChar == '\n')
            {
                string code = txtManualEntry.Text.Trim();
                txtManualEntry.Text = string.Empty;
                if (!string.IsNullOrEmpty(code))
                    HandleCode(code, false);
                e.Handled = true;
            }
        }

        // ---- Menu handlers -----------------------------------------------

        private void menuSynchro_Click(object sender, EventArgs e)
        {
            // Registration mode: all sends are live — no batch sync needed
            MessageBox.Show("Registration mode: scans are sent live.", "Sync");
        }

        private void menuSettings_Click(object sender, EventArgs e)
        {
            FormConfig fc = new FormConfig(_config);
            if (fc.ShowDialog() == DialogResult.OK)
            {
                _config = fc.Config;
                _config.Save();
                lblControlPoint.Text = _config.ControlPointName;
                lblEvent.Text = _config.EventName;
            }
        }

        private void menuSelectEvent_Click(object sender, EventArgs e)
        {
            lblStatus.Text = "Fetching events...";
            ThreadPool.QueueUserWorkItem(delegate
            {
                ServerSync sync = new ServerSync(_config);
                System.Collections.Generic.List<EventRecord> events = sync.FetchEvents();
                string fetchErr = sync.LastError;
                this.Invoke(new MethodInvoker(delegate
                {
                    if (events == null || events.Count == 0)
                    {
                        string msg = "Could not fetch events.\n" + (_config.ServerUrl ?? "(no URL)");
                        if (fetchErr != null) msg += "\n" + fetchErr;
                        MessageBox.Show(msg, "Event Fetch Failed");
                        lblStatus.Text = fetchErr != null ? fetchErr : "Event fetch failed — check server URL in Settings.";
                        return;
                    }
                    ShowEventPicker(events);
                }));
            });
        }

        private void ShowEventPicker(System.Collections.Generic.List<EventRecord> events)
        {
            FormEventPicker fp = new FormEventPicker(events);
            if (fp.ShowDialog() == DialogResult.OK && fp.SelectedEvent != null)
            {
                _config.EventId   = fp.SelectedEvent.EventId;
                _config.EventName = fp.SelectedEvent.EventName;
                _config.Save();
                lblEvent.Text  = _config.EventName;
                lblStatus.Text = "Event set: " + _config.EventName + " — fetching drivers...";

                // Pre-fetch driver list in background so it's ready when driver lookup opens
                int eventId = _config.EventId;
                ThreadPool.QueueUserWorkItem(delegate
                {
                    ServerSync sync = new ServerSync(_config);
                    System.Collections.Generic.List<DriverEntry> drivers = sync.FetchDriversForEvent(eventId);
                    this.Invoke(new MethodInvoker(delegate
                    {
                        if (drivers != null)
                        {
                            // Save to CSV cache on device
                            SaveDriversCsv(drivers);
                            lblStatus.Text = _config.EventName + " — " + drivers.Count + " drivers ready.";
                        }
                        else
                        {
                            lblStatus.Text = _config.EventName + " — driver fetch failed, using cached CSV.";
                        }
                    }));
                });
            }
        }

        /// <summary>Save a driver list to the local CSV cache.</summary>
        private void SaveDriversCsv(System.Collections.Generic.List<DriverEntry> drivers)
        {
            try
            {
                if (!System.IO.Directory.Exists(AppConfig.ConfigDir))
                    System.IO.Directory.CreateDirectory(AppConfig.ConfigDir);
                string csvPath = System.IO.Path.Combine(AppConfig.ConfigDir, "drivers.csv");
                System.Text.StringBuilder sb = new System.Text.StringBuilder();
                foreach (DriverEntry d in drivers)
                {
                    string num  = (d.VehicleNumber ?? string.Empty).Replace(",", " ");
                    string name = (d.DriverName    ?? string.Empty).Replace(",", " ");
                    string cls  = (d.ClassName     ?? string.Empty).Replace(",", " ");
                    sb.AppendLine(num + "," + name + "," + cls);
                }
                using (System.IO.StreamWriter sw = new System.IO.StreamWriter(csvPath, false, System.Text.Encoding.UTF8))
                    sw.Write(sb.ToString());
            }
            catch { }
        }

        private void menuDeleteControls_Click(object sender, EventArgs e)
        {
            if (MessageBox.Show("Delete ALL local records?\nTap OK to confirm.", "Confirm?")
                == DialogResult.OK)
            {
                DataStore.ClearAllRecords();
                lblStatus.Text = "Records cleared.";
                UpdateRecordCount();
            }
        }

        private void menuDriverLookup_Click(object sender, EventArgs e)
        {
            FormDriverLookup fd = new FormDriverLookup(_config);
            if (fd.ShowDialog() == DialogResult.OK)
            {
                if (_currentRecord == null) StartNewRecord();
                _currentRecord.VehicleNumber = fd.SelectedVehicleNumber;
                _currentRecord.DriverName    = fd.SelectedDriverName;
                _currentRecord.ClassName     = fd.SelectedClass;
                lblDriver.Text = string.Format("{0}  {1}  [{2}]",
                    fd.SelectedVehicleNumber, fd.SelectedDriverName, fd.SelectedClass);
            }
        }

        private void menuQuit_Click(object sender, EventArgs e)
        {
            if (MessageBox.Show("Exit ROKControl?\nTap OK to confirm.", "Quit?")
                == DialogResult.OK)
            {
                Application.Exit();
            }
        }

        // ---- Key handling for barcode wedge ----
        // KeyPreview=true on the form ensures all keystrokes come here first,
        // regardless of which control has focus.

        protected override void OnKeyPress(KeyPressEventArgs e)
        {
            // Don't intercept when the manual entry box has focus
            if (txtManualEntry.Focused) { base.OnKeyPress(e); return; }
            _scanner.FeedKey(e.KeyChar);
            e.Handled = true;
            base.OnKeyPress(e);
        }

        // ---- Internal helpers --------------------------------------------

        private void StartNewRecord()
        {
            _currentRecord = new ControlRecord
            {
                HeatName           = "Heat 1",
                ControlCode        = _config.ControlPointName,
                ControlPointNumber = _config.ControlPointNumber
            };
            _nextSlot = 0;
        }

        private void AdvanceToNextDriver()
        {
            ResetForm();
            lblStatus.Text = "Ready -- select next driver.";

            // Auto-open driver lookup for next driver
            FormDriverLookup fd = new FormDriverLookup(_config);
            if (fd.ShowDialog() == DialogResult.OK)
            {
                StartNewRecord();
                _currentRecord.VehicleNumber = fd.SelectedVehicleNumber;
                _currentRecord.DriverName    = fd.SelectedDriverName;
                _currentRecord.ClassName     = fd.SelectedClass;
                lblDriver.Text = string.Format("{0}  {1}  [{2}]",
                    fd.SelectedVehicleNumber, fd.SelectedDriverName, fd.SelectedClass);
                HighlightActiveSlot();
                lblStatus.Text = "Driver selected -- scan engine serial.";
            }
#if WM_DEVICE
            _captureBox.Focus();
#endif
        }

        private void PassToNext()
        {
            AdvanceToNextDriver();
        }

        private void ResetForm()
        {
            _currentRecord = null;
            _nextSlot      = 0;
            _sendPending   = false;
            _scanner.Reset();

            ClearAllSlots();
            lblDriver.Text      = "-- No driver selected --";
            lblStatus.Text      = "Ready";
            lblStatus.ForeColor = COL_TEXT;
            lblRecCount.Text    = string.Empty;
            txtManualEntry.Text = string.Empty;
            HighlightActiveSlot();
        }

        private void ApplyBranding()
        {
            lblHeader.BackColor = COL_HEADER;
            lblHeader.ForeColor = COL_TEXT;
            lblEvent.ForeColor  = COL_TEXT;
            lblControlPoint.Text = _config.ControlPointName;
            lblEvent.Text        = _config.EventName;
            pnlStatus.BackColor  = COL_STATUS_BAR;
            lblStatus.ForeColor  = COL_TEXT;
        }

        private string GetSlotTitle(int index)
        {
            if (index < DEFAULT_TITLES.Length) return DEFAULT_TITLES[index];
            return "Item " + (index + 1);
        }

        private void SetSlotDone(int index, string code)
        {
            if (index < 0 || index >= SLOT_COUNT) return;
            _slotLabels[index].Text      = code;
            _slotLabels[index].ForeColor = Color.LightGreen;
            _slotPanels[index].BackColor = COL_SCAN_DONE;
        }

        private void ClearSlot(int index)
        {
            if (index < 0 || index >= SLOT_COUNT) return;
            _slotLabels[index].Text      = "--";
            _slotLabels[index].ForeColor = Color.Gray;
            _slotPanels[index].BackColor = COL_SCAN_WAIT;
        }

        private void ClearAllSlots()
        {
            for (int i = 0; i < SLOT_COUNT; i++) ClearSlot(i);
        }

        // Highlight the next slot to be scanned in bright yellow
        private void HighlightActiveSlot()
        {
            for (int i = 0; i < SLOT_COUNT; i++)
            {
                if (i == _nextSlot && _nextSlot < SLOT_COUNT)
                {
                    // Only highlight if not already done
                    if (_slotPanels[i].BackColor != COL_SCAN_DONE)
                        _slotPanels[i].BackColor = Color.FromArgb(80, 70, 0);
                }
                else
                {
                    if (_slotPanels[i].BackColor != COL_SCAN_DONE)
                        _slotPanels[i].BackColor = COL_SCAN_WAIT;
                }
            }
        }

        private void UpdateRecordCount() { /* legacy – not used in registration mode */ }

        private void UpdateClock(object sender, EventArgs e)
        {
            lblClock.Text = DateTime.Now.ToString("HH:mm:ss");
        }
    }


}
