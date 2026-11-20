/**
 * Fluency Standard Enrollment Funnel
 * Vanilla JS interactions: video facade, plan whitelisting, resilient clipboard
 * copy, sessionStorage draft recovery, keyboard/viewport handling, file upload
 * with paste support, and simulated submission with upload progress.
 *
 * Strict CSP compatible: zero inline styles, zero eval, zero external libraries.
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------------
     1. Configuration & Constants
     BACKEND: Display metadata only. The server must always decide the real
     price from the submitted "program" plan ID.
     ------------------------------------------------------------------------ */
  var PROGRAMS = Object.freeze({
    standard: Object.freeze({
      id: "standard",
      name: "Standard",
      price: "[STANDARD_PRICE]"
    }),
    upgraded: Object.freeze({
      id: "upgraded",
      name: "Upgraded",
      price: "[UPGRADED_PRICE]"
    })
  });

  var STORAGE_KEY = "fs_enroll_draft_v1";
  var MAX_FILE_BYTES = 5 * 1024 * 1024;
  var ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
  var BD_MOBILE_REGEX = /^(?:\+?880|0)1[3-9]\d{8}$/;

  /* ------------------------------------------------------------------------
     2. Network Save-Data Awareness
     Skips HD poster upgrades and non-essential glass blur on slow connections.
     ------------------------------------------------------------------------ */
  function initSaveDataCheck() {
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    var saveData = Boolean(conn && conn.saveData);

    if (saveData) {
      document.documentElement.classList.add("save-data");
      return;
    }

    /* Upgrade poster only when Save-Data is off and viewport is laptop-sized */
    if (window.matchMedia("(min-width: 1024px)").matches) {
      var poster = document.querySelector(".video-poster[data-poster-hd]");
      var hdSrc = poster ? poster.getAttribute("data-poster-hd") : "";
      if (poster && hdSrc && hdSrc.indexOf("[") !== 0) {
        poster.src = hdSrc;
      }
    }
  }

  /* ------------------------------------------------------------------------
     3. Safe sessionStorage Helpers
     Why: Bangladeshi students frequently switch out of the browser to bKash or
     Nagad and return; low-memory phones often reload the tab. We persist only
     non-sensitive form text fields in sessionStorage (never the screenshot)
     and clear them immediately after a successful submission.
     ------------------------------------------------------------------------ */
  function readDraft() {
    try {
      var raw = window.sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function writeDraft(draftObj) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draftObj));
    } catch (err) {
      /* Ignore storage quota or private-mode restrictions */
    }
  }

  function clearDraft() {
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      /* Ignore storage access errors */
    }
  }

  function debounce(fn, waitMs) {
    var timer = null;
    return function () {
      var context = this;
      var args = arguments;
      if (timer) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(function () {
        fn.apply(context, args);
      }, waitMs);
    };
  }

  /* ------------------------------------------------------------------------
     4. Page 1: Video Facade (Inline playback, captions on by default)
     ------------------------------------------------------------------------ */
  function initVideoFacade() {
    var facade = document.querySelector("[data-video-facade]");
    if (!facade) return;

    var playBtn = facade.querySelector("[data-video-play]");
    if (!playBtn) return;

    playBtn.addEventListener("click", function () {
      var videoType = facade.getAttribute("data-video-type") || "mp4";
      var src = facade.getAttribute("data-video-src") || "";
      var captionsSrc = facade.getAttribute("data-captions-src") || "";
      var captionsLang = facade.getAttribute("data-captions-lang") || "en";
      var captionsLabel = facade.getAttribute("data-captions-label") || "English";
      var title = facade.getAttribute("data-video-title") || "Overview video";

      facade.textContent = "";

      if (videoType === "embed") {
        var iframe = document.createElement("iframe");
        iframe.className = "video-embed";
        iframe.src = src;
        iframe.title = title;
        iframe.width = "960";
        iframe.height = "540";
        iframe.allow = "autoplay; fullscreen; picture-in-picture";
        iframe.allowFullscreen = true;
        facade.appendChild(iframe);
        return;
      }

      var video = document.createElement("video");
      video.className = "video-player";
      video.controls = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.preload = "none";
      video.width = 960;
      video.height = 540;
      video.setAttribute("aria-label", title);

      var source = document.createElement("source");
      source.src = src;
      source.type = "video/mp4";
      video.appendChild(source);

      if (captionsSrc) {
        var track = document.createElement("track");
        track.kind = "captions";
        track.src = captionsSrc;
        track.srclang = captionsLang;
        track.label = captionsLabel;
        track.default = true;
        video.appendChild(track);
      }

      facade.appendChild(video);

      /* Enable captions track explicitly once metadata loads */
      video.addEventListener("loadedmetadata", function () {
        if (video.textTracks && video.textTracks.length > 0) {
          video.textTracks[0].mode = "showing";
        }
      });

      /* Never rely on autoplay succeeding in in-app browsers */
      var playPromise = video.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(function () {
          /* Native controls remain available for manual tap */
        });
      }

      video.focus();
    });
  }

  /* ------------------------------------------------------------------------
     5. Page 3: Whitelist ?program= Query Parameter
     ------------------------------------------------------------------------ */
  function resolveSelectedProgram(savedDraft) {
    var params = new URLSearchParams(window.location.search);
    var requested = (params.get("program") || "").trim().toLowerCase();

    if (Object.prototype.hasOwnProperty.call(PROGRAMS, requested)) {
      return PROGRAMS[requested];
    }

    if (savedDraft && Object.prototype.hasOwnProperty.call(PROGRAMS, savedDraft.program)) {
      return PROGRAMS[savedDraft.program];
    }

    return PROGRAMS.standard;
  }

  function applySelectedProgram(program) {
    var nameNodes = document.querySelectorAll("[data-plan-name]");
    var priceNodes = document.querySelectorAll("[data-plan-price]");
    var programInput = document.getElementById("program-input");

    nameNodes.forEach(function (node) {
      node.textContent = program.name;
    });
    priceNodes.forEach(function (node) {
      node.textContent = program.price;
    });
    if (programInput) {
      programInput.value = program.id;
    }
  }

  /* ------------------------------------------------------------------------
     6. Page 3: Resilient Copy Button (Clipboard API -> execCommand -> Select)
     ------------------------------------------------------------------------ */
  function copyTextViaTextarea(text) {
    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.className = "sr-only";
    document.body.appendChild(textarea);
    textarea.select();

    var succeeded = false;
    try {
      succeeded = document.execCommand("copy");
    } catch (err) {
      succeeded = false;
    }
    document.body.removeChild(textarea);
    return succeeded;
  }

  function selectElementText(el) {
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      var selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } catch (err) {
      /* Ignore selection failures */
    }
  }

  function initCopyButton() {
    var copyBtn = document.getElementById("copy-number-btn");
    var copyStatus = document.getElementById("copy-status");
    var copyFollowup = document.getElementById("copy-followup");
    var copyManualHint = document.getElementById("copy-manual-hint");
    if (!copyBtn) return;

    var targetId = copyBtn.getAttribute("data-copy-target");
    var targetEl = targetId ? document.getElementById(targetId) : null;
    var labelEl = copyBtn.querySelector(".copy-btn-label");
    var copyIcon = copyBtn.querySelector(".icon-copy");
    var checkIcon = copyBtn.querySelector(".icon-check");
    var revertTimer = null;

    function showCopiedFeedback() {
      if (revertTimer) window.clearTimeout(revertTimer);

      copyBtn.classList.add("is-copied");
      if (labelEl) labelEl.textContent = "Copied";
      if (copyIcon) copyIcon.hidden = true;
      if (checkIcon) checkIcon.hidden = false;
      if (copyManualHint) copyManualHint.hidden = true;
      if (copyFollowup) copyFollowup.hidden = false;
      if (copyStatus) copyStatus.textContent = "Payment number copied to clipboard.";

      revertTimer = window.setTimeout(function () {
        copyBtn.classList.remove("is-copied");
        if (labelEl) labelEl.textContent = "Copy number";
        if (copyIcon) copyIcon.hidden = false;
        if (checkIcon) checkIcon.hidden = true;
        if (copyStatus) copyStatus.textContent = "";
      }, 2000);
    }

    function showManualCopyFallback() {
      if (targetEl) selectElementText(targetEl);
      if (copyManualHint) copyManualHint.hidden = false;
      if (copyStatus) copyStatus.textContent = "Press and hold the payment number to copy.";
    }

    copyBtn.addEventListener("click", function () {
      if (!targetEl) return;
      var textToCopy = targetEl.textContent.trim();
      if (!textToCopy) return;

      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        navigator.clipboard.writeText(textToCopy).then(
          showCopiedFeedback,
          function () {
            if (copyTextViaTextarea(textToCopy)) {
              showCopiedFeedback();
            } else {
              showManualCopyFallback();
            }
          }
        );
      } else if (copyTextViaTextarea(textToCopy)) {
        showCopiedFeedback();
      } else {
        showManualCopyFallback();
      }
    });
  }

  /* ------------------------------------------------------------------------
     7. Mobile On-Screen Keyboard Guard (visualViewport + focusin/focusout)
     Prevents the sticky bottom submit bar from covering active inputs.
     ------------------------------------------------------------------------ */
  function initMobileKeyboardGuard(form) {
    var isPhoneQuery = window.matchMedia("(max-width: 599px)");

    if (window.visualViewport) {
      var baseHeight = window.innerHeight;
      var checkViewport = function () {
        if (!isPhoneQuery.matches) {
          document.body.classList.remove("keyboard-open");
          return;
        }
        var shrunk = window.visualViewport.height < baseHeight * 0.78;
        document.body.classList.toggle("keyboard-open", shrunk);
      };

      window.visualViewport.addEventListener("resize", checkViewport);
      window.addEventListener("orientationchange", function () {
        baseHeight = window.innerHeight;
        checkViewport();
      });
    }

    form.addEventListener("focusin", function (event) {
      if (!isPhoneQuery.matches) return;
      var tag = event.target ? event.target.tagName : "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
        document.body.classList.add("form-input-focused");
      }
    });

    form.addEventListener("focusout", function () {
      window.setTimeout(function () {
        var active = document.activeElement;
        var stillInside = active && form.contains(active) &&
          (active.tagName === "INPUT" || active.tagName === "SELECT" || active.tagName === "TEXTAREA");
        if (!stillInside) {
          document.body.classList.remove("form-input-focused");
        }
      }, 120);
    });
  }

  /* ------------------------------------------------------------------------
     8. Page 3: Enrollment Form, Upload (Tap / Drop / Paste), Draft Recovery
     ------------------------------------------------------------------------ */
  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  function normalizeBangladeshMobile(rawValue) {
    return rawValue.replace(/[\s\-()]/g, "");
  }

  function initEnrollmentForm() {
    var form = document.getElementById("enroll-form");
    if (!form) return;

    initMobileKeyboardGuard(form);

    var savedDraft = readDraft();
    var selectedProgram = resolveSelectedProgram(savedDraft);
    applySelectedProgram(selectedProgram);

    var submitBtn = document.getElementById("submit-btn");
    var submitLabel = submitBtn ? submitBtn.querySelector(".btn-label") : null;
    var formStatusError = document.getElementById("form-status-error");
    var uploadProgressWrap = document.getElementById("upload-progress");
    var uploadProgressBar = document.getElementById("upload-progress-bar");
    var uploadProgressPct = document.getElementById("upload-progress-pct");
    var confirmationCard = document.getElementById("enroll-confirmation");

    var fullNameInput = document.getElementById("full-name");
    var whatsappInput = document.getElementById("whatsapp");
    var emailInput = document.getElementById("email");
    var currentBandSelect = document.getElementById("current-band");
    var targetBandSelect = document.getElementById("target-band");
    var transactionIdInput = document.getElementById("transaction-id");

    var uploadZone = document.getElementById("upload-zone");
    var fileInput = document.getElementById("screenshot");
    var uploadPreview = document.getElementById("upload-preview");
    var uploadThumb = document.getElementById("upload-thumb");
    var uploadFilename = document.getElementById("upload-filename");
    var uploadFilesize = document.getElementById("upload-filesize");
    var removeFileBtn = document.getElementById("remove-file-btn");
    var screenshotError = document.getElementById("screenshot-error");

    var selectedFile = null;
    var previewObjectUrl = null;
    var isSubmitting = false;

    /* Restore saved text fields (never screenshot) */
    if (savedDraft) {
      if (fullNameInput && savedDraft.full_name) fullNameInput.value = savedDraft.full_name;
      if (whatsappInput && savedDraft.whatsapp) whatsappInput.value = savedDraft.whatsapp;
      if (emailInput && savedDraft.email) emailInput.value = savedDraft.email;
      if (currentBandSelect && savedDraft.current_band) currentBandSelect.value = savedDraft.current_band;
      if (targetBandSelect && savedDraft.target_band) targetBandSelect.value = savedDraft.target_band;
      if (transactionIdInput && savedDraft.transaction_id) transactionIdInput.value = savedDraft.transaction_id;
    }

    var persistDraft = debounce(function () {
      writeDraft({
        program: selectedProgram.id,
        full_name: fullNameInput ? fullNameInput.value : "",
        whatsapp: whatsappInput ? whatsappInput.value : "",
        email: emailInput ? emailInput.value : "",
        current_band: currentBandSelect ? currentBandSelect.value : "",
        target_band: targetBandSelect ? targetBandSelect.value : "",
        transaction_id: transactionIdInput ? transactionIdInput.value : ""
      });
    }, 250);

    function setFieldError(inputEl, errorId, message) {
      var errorEl = document.getElementById(errorId);
      if (message) {
        inputEl.setAttribute("aria-invalid", "true");
        if (errorEl) errorEl.textContent = message;
      } else {
        inputEl.removeAttribute("aria-invalid");
        if (errorEl) errorEl.textContent = "";
      }
    }

    function validateField(inputEl, showErrors) {
      var id = inputEl.id;
      var value = (inputEl.value || "").trim();
      var message = "";

      if (id === "full-name") {
        if (!value) message = "Enter your full name.";
        else if (value.length < 2) message = "Name must be at least 2 characters.";
      } else if (id === "whatsapp") {
        var normalized = normalizeBangladeshMobile(value);
        if (!normalized) message = "Enter your WhatsApp number.";
        else if (!BD_MOBILE_REGEX.test(normalized)) {
          message = "Enter a valid Bangladesh mobile number (for example 017XXXXXXXX).";
        }
      } else if (id === "email") {
        if (!value) message = "Enter your email address.";
        else if (!inputEl.validity.valid) message = "Enter a valid email address.";
      } else if (id === "current-band") {
        if (!value) message = "Select your current speaking band.";
      } else if (id === "target-band") {
        if (!value) message = "Select your target speaking band.";
      } else if (id === "transaction-id") {
        if (!value) message = "Enter the transaction ID from your receipt.";
        else if (value.length < 4) message = "Transaction ID looks too short.";
      }

      if (showErrors) {
        setFieldError(inputEl, id + "-error", message);
      }
      return message === "";
    }

    var textFields = [
      fullNameInput,
      whatsappInput,
      emailInput,
      currentBandSelect,
      targetBandSelect,
      transactionIdInput
    ].filter(Boolean);

    function areAllFieldsValid(showErrors) {
      var firstInvalid = null;
      textFields.forEach(function (field) {
        if (!validateField(field, showErrors) && !firstInvalid) {
          firstInvalid = field;
        }
      });
      return firstInvalid;
    }

    function updateSubmitState() {
      if (!submitBtn) return;
      if (isSubmitting) {
        submitBtn.disabled = true;
        return;
      }
      var hasInvalid = areAllFieldsValid(false) !== null;
      submitBtn.disabled = hasInvalid || selectedFile === null;
    }

    textFields.forEach(function (field) {
      field.addEventListener("blur", function () {
        validateField(field, true);
        updateSubmitState();
      });

      field.addEventListener("input", function () {
        if (field.getAttribute("aria-invalid") === "true") {
          validateField(field, true);
        }
        persistDraft();
        updateSubmitState();
      });

      field.addEventListener("change", function () {
        validateField(field, true);
        persistDraft();
        updateSubmitState();
      });
    });

    /* Enter on last field submits only when everything is valid */
    if (transactionIdInput) {
      transactionIdInput.addEventListener("keydown", function (event) {
        if (event.key === "Enter" && submitBtn && submitBtn.disabled) {
          event.preventDefault();
          var firstInvalid = areAllFieldsValid(true);
          if (firstInvalid) {
            firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" });
            firstInvalid.focus();
          } else if (!selectedFile && uploadZone) {
            uploadZone.classList.add("has-error");
            if (screenshotError) screenshotError.textContent = "Please attach your payment screenshot.";
            uploadZone.scrollIntoView({ behavior: "smooth", block: "center" });
            uploadZone.focus();
          }
        }
      });
    }

    /* Escape clears drag highlight or blurs active tooltip trigger */
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        if (uploadZone) uploadZone.classList.remove("is-dragover");
        if (document.activeElement && document.activeElement.id === "copy-number-btn") {
          document.activeElement.blur();
        }
      }
    });

    /* Screenshot Upload Handling (Tap, Drag & Drop, Laptop Ctrl+V Paste) */
    function clearSelectedFile(clearError) {
      selectedFile = null;
      if (previewObjectUrl) {
        URL.revokeObjectURL(previewObjectUrl);
        previewObjectUrl = null;
      }
      if (fileInput) fileInput.value = "";
      if (uploadPreview) uploadPreview.hidden = true;
      if (uploadZone) {
        uploadZone.hidden = false;
        if (clearError) uploadZone.classList.remove("has-error");
      }
      if (clearError && screenshotError) screenshotError.textContent = "";
      updateSubmitState();
    }

    function assignFileToInput(file) {
      if (!fileInput || typeof DataTransfer === "undefined") return;
      try {
        var dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
      } catch (err) {
        /* Some older in-app browsers disallow setting input.files */
      }
    }

    function handleFileSelection(file) {
      if (!file) return;

      if (ALLOWED_MIME_TYPES.indexOf(file.type) === -1) {
        clearSelectedFile(false);
        if (uploadZone) uploadZone.classList.add("has-error");
        if (screenshotError) screenshotError.textContent = "Please upload a JPG, PNG, or WEBP image.";
        return;
      }

      if (file.size > MAX_FILE_BYTES) {
        clearSelectedFile(false);
        if (uploadZone) uploadZone.classList.add("has-error");
        if (screenshotError) screenshotError.textContent = "File is larger than 5MB. Please upload a smaller screenshot.";
        return;
      }

      if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);

      selectedFile = file;
      previewObjectUrl = URL.createObjectURL(file);

      if (uploadZone) {
        uploadZone.classList.remove("has-error");
        uploadZone.hidden = true;
      }
      if (screenshotError) screenshotError.textContent = "";
      if (uploadThumb) uploadThumb.src = previewObjectUrl;
      if (uploadFilename) uploadFilename.textContent = file.name || "pasted-screenshot.png";
      if (uploadFilesize) uploadFilesize.textContent = formatFileSize(file.size);
      if (uploadPreview) uploadPreview.hidden = false;

      updateSubmitState();
    }

    if (uploadZone && fileInput) {
      uploadZone.addEventListener("click", function () {
        fileInput.click();
      });

      uploadZone.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          fileInput.click();
        }
      });

      /* Laptop paste-to-upload when upload zone is focused */
      uploadZone.addEventListener("paste", function (event) {
        var clipboardData = event.clipboardData || window.clipboardData;
        if (!clipboardData || !clipboardData.items) return;

        for (var i = 0; i < clipboardData.items.length; i += 1) {
          var item = clipboardData.items[i];
          if (item.kind === "file" && ALLOWED_MIME_TYPES.indexOf(item.type) !== -1) {
            event.preventDefault();
            var pastedFile = item.getAsFile();
            if (pastedFile) {
              assignFileToInput(pastedFile);
              handleFileSelection(pastedFile);
            }
            return;
          }
        }
      });

      ["dragenter", "dragover"].forEach(function (eventName) {
        uploadZone.addEventListener(eventName, function (event) {
          event.preventDefault();
          event.stopPropagation();
          uploadZone.classList.add("is-dragover");
        });
      });

      ["dragleave", "drop"].forEach(function (eventName) {
        uploadZone.addEventListener(eventName, function (event) {
          event.preventDefault();
          event.stopPropagation();
          uploadZone.classList.remove("is-dragover");
        });
      });

      uploadZone.addEventListener("drop", function (event) {
        var files = event.dataTransfer ? event.dataTransfer.files : null;
        if (files && files.length > 0) {
          assignFileToInput(files[0]);
          handleFileSelection(files[0]);
        }
      });

      fileInput.addEventListener("change", function () {
        if (fileInput.files && fileInput.files.length > 0) {
          handleFileSelection(fileInput.files[0]);
        }
      });
    }

    if (removeFileBtn) {
      removeFileBtn.addEventListener("click", function () {
        clearSelectedFile(true);
        if (uploadZone) uploadZone.focus();
      });
    }

    function setUploadProgress(percent) {
      if (uploadProgressWrap) uploadProgressWrap.hidden = false;
      if (uploadProgressBar) uploadProgressBar.value = percent;
      if (uploadProgressPct) uploadProgressPct.textContent = percent + "%";
    }

    function resetSubmittingState(errorMessage) {
      isSubmitting = false;
      if (uploadProgressWrap) uploadProgressWrap.hidden = true;
      if (submitBtn) {
        submitBtn.classList.remove("is-loading");
      }
      if (submitLabel) submitLabel.textContent = "Submit enrollment";
      if (formStatusError) {
        formStatusError.textContent = errorMessage || "";
      }
      updateSubmitState();
    }

    function showConfirmationState() {
      clearDraft();
      isSubmitting = false;
      form.hidden = true;

      var enrollIntro = document.getElementById("enroll-intro");
      var mobileSummary = document.getElementById("mobile-summary-bar");
      if (enrollIntro) enrollIntro.hidden = true;
      if (mobileSummary) mobileSummary.hidden = true;

      if (confirmationCard) {
        confirmationCard.hidden = false;
        confirmationCard.focus();
        confirmationCard.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (isSubmitting) return;

      var firstInvalid = areAllFieldsValid(true);
      if (!selectedFile) {
        if (uploadZone) uploadZone.classList.add("has-error");
        if (screenshotError) screenshotError.textContent = "Please attach your payment screenshot.";
        if (!firstInvalid && uploadZone) firstInvalid = uploadZone;
      }

      if (firstInvalid) {
        firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" });
        firstInvalid.focus();
        updateSubmitState();
        return;
      }

      isSubmitting = true;
      if (formStatusError) formStatusError.textContent = "";
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.classList.add("is-loading");
      }
      if (submitLabel) submitLabel.textContent = "Submitting...";
      setUploadProgress(15);

      /*
       * TODO / BACKEND: Replace the simulated upload progress below with
       * XMLHttpRequest (for real upload.onprogress events) posting FormData
       * to form.action ("/api/enroll"). On network failure, call:
       *   resetSubmittingState("Connection interrupted. Your details are still here. Please try again.");
       * so the form is never cleared on a failed attempt.
       */
      var progress = 15;
      var tick = window.setInterval(function () {
        progress = Math.min(progress + 30, 100);
        setUploadProgress(progress);

        if (progress >= 100) {
          window.clearInterval(tick);
          window.setTimeout(showConfirmationState, 220);
        }
      }, 260);
    });

    updateSubmitState();
  }

  /* ------------------------------------------------------------------------
     9. Bootstrap
     ------------------------------------------------------------------------ */
  document.addEventListener("DOMContentLoaded", function () {
    initSaveDataCheck();
    initVideoFacade();
    initCopyButton();
    initEnrollmentForm();
  });
})();