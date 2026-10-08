# Call driver for R (docs/design/runner.md section 4.5).
#
# Run as `Rscript --vanilla driver.R SPEC`. SPEC is a JSON file the harness wrote in the
# check's private directory: { file, function, args, kwargs, outcomePath }. The check's stdin
# is left whole for the student function (unlike driver.py, nothing is read from fd 0: R's
# connections buffer, so a first line read from stdin would swallow part of the student's
# input). The driver never receives `expected` or `compare`: the harness compares.
#
# The outcome is written to `outcomePath` as one JSON document:
#
#   { "ok": true,  "value": <json or null>, "jsonable": bool, "repr": str }
#   { "ok": false, "exception": { "type": str, "bases": [str, ...], "message": str } }
#
# Every string is valid UTF-8 (invalid bytes become U+FFFD), so the document is readable.
#
# Everything below lives in a private environment whose parent is the base environment, so
# nothing the student file defines or sources into the global environment (a function named
# `to_json`, even `paste`) can replace what the driver uses.

local({

  NOT_JSON <- "parallax_not_json"

  clean_text <- function(s) {
    s <- as.character(s)
    bad <- !is.na(s) & !validUTF8(s)
    if (any(bad)) {
      s[bad] <- iconv(s[bad], "UTF-8", "UTF-8", sub = "\uFFFD")
      still <- !is.na(s) & !validUTF8(s)
      if (any(still)) s[still] <- "\uFFFD"
    }
    s
  }

  # One JSON string text per element of a character vector, in a single serialiser call (NA is
  # null). The array text is split again with a string-aware pattern: jsonlite escapes every
  # quote inside a string, so the tokens are exactly the elements.
  string_items <- function(s, cleaned = FALSE) {
    if (length(s) == 0L) return(character(0))
    if (!cleaned) s <- clean_text(s)
    text <- as.character(jsonlite::toJSON(s, na = "null"))
    # useBytes: character offsets in a long UTF-8 text make the matching quadratic. The
    # pattern never matches the outer brackets.
    tokens <- tryCatch(
      regmatches(text, gregexpr("\"(?:[^\"\\\\]++|\\\\.)*+\"|null", text, perl = TRUE, useBytes = TRUE))[[1L]],
      warning = function(w) NULL, error = function(e) NULL
    )
    if (length(tokens) != length(s)) {
      # The split failed: serialise element by element rather than return a wrong count.
      return(vapply(s, function(one) {
        if (is.na(one)) "null" else as.character(jsonlite::toJSON(one, auto_unbox = TRUE))
      }, "", USE.NAMES = FALSE))
    }
    Encoding(tokens) <- "UTF-8"
    tokens
  }

  json_string <- function(s) {
    as.character(jsonlite::toJSON(clean_text(s)[[1L]], auto_unbox = TRUE))
  }

  not_json <- function() stop(structure(class = c(NOT_JSON, "error", "condition"),
                                        list(message = "not json", call = NULL)))

  # One JSON text per element of an atomic vector (NA is null, NaN and the infinities strings).
  atom_items <- function(x) {
    if (is.logical(x)) {
      return(ifelse(is.na(x), "null", ifelse(x, "true", "false")))
    }
    if (is.integer(x)) {
      return(ifelse(is.na(x), "null", as.character(x)))
    }
    if (is.double(x)) {
      out <- sprintf("%.17g", x)
      out[is.nan(x)] <- "\"NaN\""
      out[!is.na(x) & x == Inf] <- "\"Infinity\""
      out[!is.na(x) & x == -Inf] <- "\"-Infinity\""
      out[is.na(x) & !is.nan(x)] <- "null"
      return(out)
    }
    if (is.character(x)) {
      return(string_items(x))
    }
    not_json()
  }

  object_text <- function(keys, items) {
    if (length(keys) == 0L) return("{}")
    keys <- clean_text(keys)
    if (anyNA(keys) || any(keys == "") || anyDuplicated(keys)) not_json()
    paste0("{", paste0(string_items(keys, cleaned = TRUE), ":", items, collapse = ","), "}")
  }

  to_json <- function(x) {
    if (is.null(x)) return("null")
    if (is.factor(x)) x <- as.character(x)
    if (is.data.frame(x)) x <- as.list(x)
    extra <- setdiff(names(attributes(x)), "names")
    if (length(extra)) not_json()
    if (is.list(x)) {
      items <- vapply(x, to_json, "")
      if (is.null(names(x))) return(paste0("[", paste(items, collapse = ","), "]"))
      return(object_text(names(x), items))
    }
    items <- atom_items(x)
    if (!is.null(names(x))) return(object_text(names(x), items))
    if (length(x) == 1L) return(items[[1L]])
    paste0("[", paste(items, collapse = ","), "]")
  }

  # deparse is quadratic in the length of an escape-heavy string (1.2 M characters of
  # \n, \t, quotes and non-ASCII take ~19 s, 6 M exceed the check's time limit), while 64 Ki
  # characters take milliseconds. The repr text is compared with expected.value in `repr` mode
  # and with the expected value of a non-JSON result in the other modes (design section 4.4),
  # and it is shown in messages, so nothing within the bound may change: a character string
  # longer than REPR_CHARS characters is cut to its first REPR_CHARS characters plus an
  # ellipsis, in plain (unclassed) character vectors and plain lists only. A value with
  # nothing to cut is deparsed as it is, attributes and classes included; a string in a
  # classed container, a name or an attribute is deparsed whole; and if bounding fails (a
  # list nested too deeply for the recursion, a string with a "bytes" encoding) the value is
  # deparsed whole, as it was before the bound existed.
  REPR_CHARS <- 65536L

  # TRUE if a plain character vector anywhere in the plain list x has a string over the
  # limit in bytes (a cheap upper bound of its characters). rapply walks in C and calls back
  # only for character leaves, so a list of numbers costs almost nothing.
  has_long_string <- function(x) {
    any(rapply(x, function(s) any(nchar(s, type = "bytes") > REPR_CHARS, na.rm = TRUE),
               classes = "character", deflt = FALSE, how = "unlist"))
  }

  bound_for_repr <- function(x) {
    if (is.character(x) && !is.object(x)) {
      big <- which(!is.na(x) & nchar(x, type = "bytes") > REPR_CHARS)
      if (length(big)) {
        text <- clean_text(enc2utf8(x[big]))
        cut <- nchar(text, type = "chars") > REPR_CHARS
        if (any(cut)) {
          x[big[cut]] <- paste0(substr(text[cut], 1L, REPR_CHARS), "\u2026")
        }
      }
    } else if (is.vector(x, "list") && !is.object(x) && length(x) && has_long_string(x)) {
      x[] <- lapply(x, bound_for_repr)
    }
    x
  }

  repr_text <- function(x) {
    tryCatch({
      bounded <- tryCatch(bound_for_repr(x), error = function(e) x)
      clean_text(paste(trimws(deparse(bounded, width.cutoff = 500L)), collapse = " "))
    }, error = function(e) "<unrepresentable>")
  }

  # JSON from the harness to R values: arrays of scalars of one kind become atomic vectors
  # (an empty array is logical(0)), objects named lists, everything else lists. An array
  # with an array among its items stays a list, so [[1],[2]] is list(1, 2), not c(1, 2).
  from_json <- function(x) {
    if (!is.list(x)) {
      # JSON integers are doubles, as a number typed in R is: n * n must not overflow.
      if (is.integer(x)) storage.mode(x) <- "double"
      return(x)
    }
    items <- lapply(x, from_json)
    if (!is.null(names(x))) return(items)
    if (length(items) == 0L) return(logical(0))
    if (any(vapply(x, is.list, NA))) return(items)
    missing <- vapply(items, is.null, NA)
    present <- items[!missing]
    scalar <- length(present) > 0L &&
      all(vapply(present, function(i) is.atomic(i) && length(i) == 1L, NA))
    if (scalar) {
      types <- unique(vapply(present, typeof, ""))
      if (length(types) == 1L || all(types %in% c("integer", "double"))) {
        # A null among scalars is a missing value, as on the output side.
        items[missing] <- list(NA)
        return(unlist(items))
      }
    }
    items
  }

  exception_text <- function(e) {
    classes <- clean_text(class(e))
    message <- tryCatch(conditionMessage(e), error = function(e2) "")
    paste0(
      "{\"ok\":false,\"exception\":{\"type\":", json_string(classes[[1L]]),
      ",\"bases\":[", paste(string_items(classes[-1L], cleaned = TRUE), collapse = ","),
      "],\"message\":", json_string(paste(message, collapse = "\n")), "}}"
    )
  }

  outcome_text <- function(spec) {
    # stop(cond) with a condition that does not inherit "error" would halt Rscript. The calling
    # handler below turns it into an exception, but only the condition a stop() frame is
    # signalling: a signalCondition() call, or a signal raised from a handler while an
    # unrelated stop() is on the stack, is not an exception.
    stop_fn <- stop
    from_stop <- function(cond) {
      # Only the frame directly below the handler can be stop(): it signals through
      # .signalCondition from its own frame. Walking the whole stack would cost time
      # proportional to its depth for every message() in a deeply recursive solution.
      i <- sys.nframe() - 2L
      i >= 1L && identical(sys.function(i), stop_fn) &&
        identical(get0("cond", sys.frame(i), inherits = FALSE), cond)
    }
    # quit() and q() end the call like an exception (Python's SystemExit), not the driver. The
    # override sits in the global environment, so student helpers sourced there reach it too.
    exit_call <- function(save = "default", status = 0, runLast = TRUE) {
      stop(structure(class = c("SystemExit", "quit_called", "condition"),
                     list(message = paste("quit called with status", status), call = NULL)))
    }
    state <- tryCatch(withCallingHandlers({
      env <- new.env(parent = globalenv())
      assign("quit", exit_call, envir = globalenv())
      assign("q", exit_call, envir = globalenv())
      source(spec$file, local = env, encoding = "UTF-8")
      # The student file's own definitions: its environment first, then what it sourced into the
      # global environment (empty in a fresh Rscript, so base R is never searched).
      name <- spec$`function`
      holder <- if (exists(name, envir = env, mode = "function", inherits = FALSE)) env else globalenv()
      fn <- get(name, envir = holder, mode = "function", inherits = FALSE)
      # The driver's own override, found in the global environment, is not solution code. The
      # same function reached through the solution file's environment (`finish <- quit`) is the
      # solution's own binding and is called as usual; a helper sourced into the global
      # environment with `finish <- quit` cannot be told apart from the override and is not found.
      if (identical(holder, globalenv()) && identical(fn, exit_call)) {
        stop(sprintf("object '%s' of mode 'function' was not found", name))
      }
      args <- lapply(spec$args, from_json)
      kwargs <- lapply(spec$kwargs, from_json)
      list(value = do.call(fn, c(args, kwargs)))
    }, condition = function(cond) {
      if (!inherits(cond, c("error", "quit_called")) && from_stop(cond)) {
        signalCondition(structure(class = c("driver_stop", "condition"), list(message = "", call = NULL, cond = cond)))
      }
    }), error = function(e) e, quit_called = function(e) e, driver_stop = function(e) e$cond)
    if (inherits(state, "condition")) return(exception_text(state))
    value <- state$value
    json <- tryCatch(to_json(value), error = function(e) NULL)
    paste0(
      "{\"ok\":true,\"value\":", if (is.null(json)) "null" else json,
      ",\"jsonable\":", if (is.null(json)) "false" else "true",
      ",\"repr\":", json_string(repr_text(value)), "}"
    )
  }

  main <- function() {
    path <- commandArgs(trailingOnly = TRUE)[[1L]]
    raw <- readBin(path, "raw", file.size(path))
    text <- rawToChar(raw)
    Encoding(text) <- "UTF-8"
    spec <- jsonlite::parse_json(text)
    body <- outcome_text(spec)
    handle <- file(spec$outcomePath, "wb")
    on.exit(close(handle))
    writeBin(charToRaw(body), handle)
    invisible(0L)
  }

  main()
}, envir = new.env(parent = baseenv()))
