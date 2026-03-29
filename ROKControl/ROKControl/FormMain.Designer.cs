using System;
using System.Drawing;
using System.Windows.Forms;

namespace ROKControl
{
    partial class FormMain
    {
        // Slot arrays (11 items)
        private Panel[]  _slotPanels;
        private Label[]  _slotTitleLabels;
        private Label[]  _slotLabels;

        // Header
        private Panel   pnlHeader;
        private Label   lblHeader;
        private Label   lblEvent;
        private Label   lblControlPoint;
        private Label   lblClock;
        private Timer   tmrClock;

        // Driver info bar
        private Panel   pnlDriver;
        private Label   lblDriver;

        // Tyre RFID bar
        private Panel   pnlTyre;
        private Label   lblTyreFL;
        private Label   lblTyreFR;
        private Label   lblTyreRL;
        private Label   lblTyreRR;

        // Scan slots scrollable area
        private Panel   pnlSlots;

        // Status bar
        private Panel   pnlStatus;
        private Label   lblStatus;
        private Label   lblRecCount;

        // Bottom buttons
        private Panel   pnlButtons;
        private Button  btnMain;
        private Button  btnPassToNext;
        private Button  btnRemoveLast;
        private Button  btnSendLive;

        // Manual barcode entry (desktop testing)
        private Panel   pnlManual;
        private Label   lblManualHint;
        private TextBox txtManualEntry;

        // Menu
        private MainMenu mainMenu;
        private MenuItem menuItemFile;
        private MenuItem menuItemSync;
        private MenuItem menuItemSettings;
        private MenuItem menuItemDeleteControls;
        private MenuItem menuItemDriverLookup;
        private MenuItem menuItemSelectEvent;
        private MenuItem menuItemQuit;

        private void InitializeComponent()
        {
            this.Text            = "ROKControl";
            this.ClientSize      = new Size(480, 622);
            this.FormBorderStyle = FormBorderStyle.FixedSingle;
            this.MaximizeBox     = false;
            this.KeyPreview      = true;

            // ---- Menu ----
            mainMenu              = new MainMenu();
            menuItemFile          = new MenuItem();
            menuItemSync          = new MenuItem();
            menuItemSettings      = new MenuItem();
            menuItemDeleteControls = new MenuItem();
            menuItemDriverLookup  = new MenuItem();
            menuItemSelectEvent   = new MenuItem();
            menuItemQuit          = new MenuItem();

            menuItemFile.Text          = "Menu";
            menuItemSync.Text          = "Sync Info";
            menuItemSettings.Text      = "Settings";
            menuItemDeleteControls.Text = "Delete Records";
            menuItemDriverLookup.Text  = "Select Driver";
            menuItemSelectEvent.Text    = "Select Event";
            menuItemQuit.Text          = "Quit";

            menuItemSync.Click          += menuSynchro_Click;
            menuItemSettings.Click      += menuSettings_Click;
            menuItemDeleteControls.Click += menuDeleteControls_Click;
            menuItemDriverLookup.Click  += menuDriverLookup_Click;
            menuItemSelectEvent.Click   += menuSelectEvent_Click;
            menuItemQuit.Click          += menuQuit_Click;

            menuItemFile.MenuItems.Add(menuItemDriverLookup);
            menuItemFile.MenuItems.Add(menuItemSelectEvent);
            menuItemFile.MenuItems.Add(menuItemSync);
            menuItemFile.MenuItems.Add(menuItemSettings);
            menuItemFile.MenuItems.Add(menuItemDeleteControls);
            menuItemFile.MenuItems.Add(menuItemQuit);
            mainMenu.MenuItems.Add(menuItemFile);
            this.Menu = mainMenu;

            // ---- Header panel (30px) ----
            pnlHeader          = new Panel();
            pnlHeader.Bounds   = new Rectangle(0, 0, 480, 36);
            pnlHeader.BackColor = Color.FromArgb(180, 0, 0);

            lblHeader          = new Label();
            lblHeader.Text     = "ROK CONTROL";
            lblHeader.Font     = new Font("Tahoma", 9, FontStyle.Bold);
            lblHeader.ForeColor = Color.White;
            lblHeader.Bounds   = new Rectangle(8, 4, 280, 28);

            lblClock           = new Label();
            lblClock.Text      = "00:00:00";
            lblClock.Font      = new Font("Tahoma", 9, FontStyle.Regular);
            lblClock.ForeColor = Color.White;
            lblClock.TextAlign = (ContentAlignment)64; // MiddleRight
            lblClock.Bounds    = new Rectangle(310, 4, 160, 28);

            pnlHeader.Controls.Add(lblHeader);
            pnlHeader.Controls.Add(lblClock);
            this.Controls.Add(pnlHeader);

            // Event / control point bar (18px)
            lblEvent           = new Label();
            lblEvent.Bounds    = new Rectangle(0, 36, 240, 18);
            lblEvent.Font      = new Font("Tahoma", 7, FontStyle.Regular);
            lblEvent.ForeColor = Color.LightGray;
            lblEvent.BackColor = Color.FromArgb(35, 35, 50);
            lblEvent.Text      = "Event";

            lblControlPoint    = new Label();
            lblControlPoint.Bounds = new Rectangle(240, 36, 240, 18);
            lblControlPoint.Font = new Font("Tahoma", 7, FontStyle.Bold);
            lblControlPoint.ForeColor = Color.Yellow;
            lblControlPoint.BackColor = Color.FromArgb(35, 35, 50);
            lblControlPoint.TextAlign = (ContentAlignment)64; // MiddleRight
            lblControlPoint.Text = "Control";

            this.Controls.Add(lblEvent);
            this.Controls.Add(lblControlPoint);

            // ---- Driver bar ----
            pnlDriver          = new Panel();
            pnlDriver.Bounds   = new Rectangle(0, 54, 480, 36);
            pnlDriver.BackColor = Color.FromArgb(0, 60, 0);

            lblDriver          = new Label();
            lblDriver.Bounds   = new Rectangle(4, 2, 472, 32);
            lblDriver.Font     = new Font("Tahoma", 8, FontStyle.Bold);
            lblDriver.ForeColor = Color.White;
            lblDriver.Text     = "â€” No driver selected â€”";
            pnlDriver.Controls.Add(lblDriver);
            this.Controls.Add(pnlDriver);

            // Tyre RFID bar removed -- scan slots handle tyre barcodes
            pnlTyre = new Panel();
            pnlTyre.Visible = false;
            lblTyreFL = lblTyreFR = lblTyreRL = lblTyreRR = new Label();
            this.Controls.Add(pnlTyre);

            // ---- Scan slots (11 rows x 36px = 396px, no scroll) ----
            pnlSlots           = new Panel();
            pnlSlots.Bounds    = new Rectangle(0, 90, 480, 396);
            pnlSlots.BackColor = Color.FromArgb(20, 20, 30);
            pnlSlots.AutoScroll = false;

            _slotPanels      = new Panel[SLOT_COUNT];
            _slotTitleLabels = new Label[SLOT_COUNT];
            _slotLabels      = new Label[SLOT_COUNT];

            for (int i = 0; i < SLOT_COUNT; i++)
            {
                int y = i * 36;
                Panel p      = new Panel();
                p.Bounds     = new Rectangle(0, y, 480, 35);
                p.BackColor  = Color.FromArgb(40, 40, 55);

                Label lTitle = new Label();
                lTitle.Bounds    = new Rectangle(4, 2, 180, 31);
                lTitle.Font      = new Font("Tahoma", 7, FontStyle.Regular);
                lTitle.ForeColor = Color.LightGray;
                lTitle.Text      = DEFAULT_TITLES[i];

                Label lCode  = new Label();
                lCode.Bounds     = new Rectangle(188, 2, 288, 31);
                lCode.Font       = new Font("Tahoma", 7, FontStyle.Bold);
                lCode.ForeColor  = Color.Gray;
                lCode.Text       = "â€”";

                p.Controls.Add(lTitle);
                p.Controls.Add(lCode);
                pnlSlots.Controls.Add(p);

                _slotPanels[i]      = p;
                _slotTitleLabels[i] = lTitle;
                _slotLabels[i]      = lCode;
            }

            this.Controls.Add(pnlSlots);

            // ---- Status bar ----
            pnlStatus          = new Panel();
            pnlStatus.Bounds   = new Rectangle(0, 486, 480, 22);
            pnlStatus.BackColor = Color.FromArgb(30, 30, 45);

            lblStatus          = new Label();
            lblStatus.Bounds   = new Rectangle(4, 2, 360, 18);
            lblStatus.Font     = new Font("Tahoma", 7, FontStyle.Regular);
            lblStatus.ForeColor = Color.White;
            lblStatus.Text     = "Ready";

            lblRecCount        = new Label();
            lblRecCount.Bounds = new Rectangle(368, 2, 108, 18);
            lblRecCount.Font   = new Font("Tahoma", 7, FontStyle.Regular);
            lblRecCount.ForeColor = Color.LightYellow;
            lblRecCount.TextAlign = (ContentAlignment)64; // MiddleRight
            lblRecCount.Text   = "Records: 0";

            pnlStatus.Controls.Add(lblStatus);
            pnlStatus.Controls.Add(lblRecCount);
            this.Controls.Add(pnlStatus);

            // ---- Buttons row ----
            pnlButtons         = new Panel();
            pnlButtons.Bounds  = new Rectangle(0, 508, 480, 76);
            pnlButtons.BackColor = Color.FromArgb(25, 25, 40);

            btnMain            = MakeButton("CLEAR",   0,  120);
            btnPassToNext      = MakeButton("NEXT",   120,  120);
            btnRemoveLast      = MakeButton("REMOVE", 240,  120);
            btnSendLive        = MakeButton("RETRY",  360,  120);

            btnMain.BackColor       = Color.FromArgb(80, 0, 0);
            btnPassToNext.BackColor = Color.FromArgb(0, 80, 0);
            btnRemoveLast.BackColor = Color.FromArgb(60, 60, 0);
            btnSendLive.BackColor   = Color.FromArgb(0, 0, 100);

            btnMain.Click       += btnMain_Click;
            btnPassToNext.Click += btnPassToNext_Click;
            btnRemoveLast.Click += btnRemoveLast_Click;
            btnSendLive.Click   += btnSendLive_Click;

            pnlButtons.Controls.Add(btnMain);
            pnlButtons.Controls.Add(btnPassToNext);
            pnlButtons.Controls.Add(btnRemoveLast);
            pnlButtons.Controls.Add(btnSendLive);
            this.Controls.Add(pnlButtons);

            // ---- Manual entry bar (desktop testing) ----
            pnlManual          = new Panel();
            pnlManual.Bounds   = new Rectangle(0, 584, 480, 40);
            pnlManual.BackColor = Color.FromArgb(15, 15, 25);

            lblManualHint      = new Label();
            lblManualHint.Bounds = new Rectangle(4, 10, 120, 20);
            lblManualHint.Font = new Font("Tahoma", 7, FontStyle.Regular);
            lblManualHint.ForeColor = Color.Gray;
            lblManualHint.Text = "Test: type + Enter";

            txtManualEntry     = new TextBox();
            txtManualEntry.Bounds = new Rectangle(130, 8, 344, 24);
            txtManualEntry.Font = new Font("Tahoma", 9, FontStyle.Regular);
            txtManualEntry.BackColor = Color.FromArgb(35, 35, 55);
            txtManualEntry.ForeColor = Color.White;

            pnlManual.Controls.Add(lblManualHint);
            pnlManual.Controls.Add(txtManualEntry);
            this.Controls.Add(pnlManual);

            // ---- Clock timer ----
            tmrClock          = new Timer();
            tmrClock.Interval = 1000;
            tmrClock.Tick    += UpdateClock;
            tmrClock.Enabled  = true;
        }

        // ---- Layout helpers ----
        private static Label MakeTyreLabel(string text, int x, int w)
        {
            return new Label
            {
                Text       = text,
                Bounds = new Rectangle(x + 1, 4, w - 2, 36),
                Font       = new Font("Tahoma", 8, FontStyle.Regular),
                ForeColor  = Color.Cyan,
                BackColor  = Color.Transparent
            };
        }

        private static Button MakeButton(string text, int x, int w)
        {
            return new Button
            {
                Text      = text,
                Bounds = new Rectangle(x + 1, 4, w - 2, 80),
                Font      = new Font("Tahoma", 7, FontStyle.Bold),
                ForeColor = Color.White,
                BackColor = Color.FromArgb(60, 60, 80)
            };
        }
    }
}


