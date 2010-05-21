var EXPORTED_SYMBOLS = ['Storage', 'Query'];

const Cc = Components.classes;
const Ci = Components.interfaces;

const PURGE_ENTRIES_INTERVAL = 3600*24; // 1 day
const DELETED_FEEDS_RETENTION_TIME = 3600*24*7; // 1 week
const LIVEMARKS_SYNC_DELAY = 100;
const BACKUP_FILE_EXPIRATION_AGE = 3600*24*14; // 2 weeks
const DATABASE_VERSION = 10;

const FEEDS_TABLE_SCHEMA =
    'feedID          TEXT UNIQUE,         ' +
    'feedURL         TEXT,                ' +
    'websiteURL      TEXT,                ' +
    'title           TEXT,                ' +
    'subtitle        TEXT,                ' +
    'imageURL        TEXT,                ' +
    'imageLink       TEXT,                ' +
    'imageTitle      TEXT,                ' +
    'favicon         TEXT,                ' +
    'bookmarkID      TEXT,                ' +
    'rowIndex        INTEGER,             ' +
    'parent          TEXT,                ' +
    'isFolder        INTEGER,             ' +
    'hidden          INTEGER DEFAULT 0,   ' +
    'lastUpdated     INTEGER DEFAULT 0,   ' +
    'oldestEntryDate INTEGER,             ' +
    'entryAgeLimit   INTEGER DEFAULT 0,   ' +
    'maxEntries      INTEGER DEFAULT 0,   ' +
    'updateInterval  INTEGER DEFAULT 0,   ' +
    'dateModified    INTEGER DEFAULT 0,   ' +
    'markModifiedEntriesUnread INTEGER DEFAULT 1 ';

const ENTRIES_TABLE_SCHEMA =
    'id            INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'feedID        TEXT,               ' +
    'primaryHash   TEXT,               ' +
    'secondaryHash TEXT,               ' +
    'providedID    TEXT,               ' +
    'entryURL      TEXT,               ' +
    'date          INTEGER,            ' +
    'read          INTEGER DEFAULT 0,  ' +
    'updated       INTEGER DEFAULT 0,  ' +
    'starred       INTEGER DEFAULT 0,  ' +
    'deleted       INTEGER DEFAULT 0,  ' +
    'bookmarkID    INTEGER DEFAULT -1  ';

const ENTRIES_TEXT_TABLE_SCHEMA =
    'title   TEXT, ' +
    'content TEXT, ' +
    'authors TEXT, ' +
    'tags    TEXT  ';

const ENTRY_TAGS_TABLE_SCHEMA =
    'tagID    INTEGER, ' +
    'tagName  TEXT,    ' +
    'entryID  INTEGER  ';

const REASON_FINISHED = Ci.mozIStorageStatementCallback.REASON_FINISHED;
const REASON_ERROR = Ci.mozIStorageStatementCallback.REASON_ERROR;


Components.utils.import('resource://brief/FeedContainer.jsm');
Components.utils.import('resource://brief/FeedUpdateService.jsm');
Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');

XPCOMUtils.defineLazyServiceGetter(this, 'ObserverService', '@mozilla.org/observer-service;1', 'nsIObserverService');
XPCOMUtils.defineLazyServiceGetter(this, 'Bookmarks', '@mozilla.org/browser/nav-bookmarks-service;1', 'nsINavBookmarksService');

XPCOMUtils.defineLazyGetter(this, 'Prefs', function()
    Cc['@mozilla.org/preferences-service;1'].getService(Ci.nsIPrefService).
                                             getBranch('extensions.brief.').
                                             QueryInterface(Ci.nsIPrefBranch2)
);
XPCOMUtils.defineLazyGetter(this, 'Places', function() {
    var tempScope = {};
    Components.utils.import('resource://gre/modules/utils.js', tempScope);
    return tempScope.PlacesUtils;
});


var Connection = null;

function ExecuteSQL(aSQLString) {
    try {
        Connection.executeSimpleSQL(aSQLString);
    }
    catch (ex) {
        log('SQL statement: ' + aSQLString);
        ReportError(ex, true);
    }
}

function CreateStatement(aSQLString) {
    try {
        var statement = Connection.createStatement(aSQLString);
    }
    catch (ex) {
        log('SQL statement:\n' + aSQLString);
        ReportError(ex, true);
    }
    return statement;
}

function ExecuteStatementsAsync(aStatements, aCallback) {
    var nativeStatements = [];

    for (let i = 0; i < aStatements.length; i++) {
        aStatements[i]._bindParams();
        nativeStatements.push(aStatements[i]._wrappedStatement);
    }

    var callback = aCallback || {};
    if (!callback.handleError) {
        callback.handleError = function(aError) {
            ReportError(aError.message);
        }
    }
    if (!callback.handleCompletion) {
        callback.handleCompletion = function() {}
    }

    Connection.executeAsync(nativeStatements, nativeStatements.length, callback);
}

function Statement(aSQLString, aDefaultParams) {
    this._wrappedStatement = CreateStatement(aSQLString);
    this._defaultParams = aDefaultParams;
    this.paramSets = [];
    this.params = {};
}

Statement.prototype = {

    execute: function Statement_execute(aParams) {
        if (aParams)
            this.params = aParams;

        this._bindParams();
        this._wrappedStatement.execute();
    },

    executeAsync: function Statement_executeAsync(aCallback) {
        var callback = aCallback || {};

        if (!callback.handleError) {
            callback.handleError = function(aError) {
                ReportError(aError.message);
            }
        }
        if (!callback.handleCompletion) {
            callback.handleCompletion = function() {}
        }

        this._bindParams();
        this._wrappedStatement.executeAsync(callback);
    },

    _bindParams: function Statement__bindParams() {
        for (let column in this._defaultParams)
            this._wrappedStatement.params[column] = this._defaultParams[column];

        if (!this.paramSets.length) {
            for (let column in this.params)
                this._wrappedStatement.params[column] = this.params[column];
        }
        else {
            let bindingParamsArray = this._wrappedStatement.newBindingParamsArray();

            for (let i = 0; i < this.paramSets.length; i++) {
                let set = this.paramSets[i];
                let bp = bindingParamsArray.newBindingParams();
                for (let column in set)
                    bp.bindByName(column, set[column])
                bindingParamsArray.addParams(bp);
            }

            this._wrappedStatement.bindParameters(bindingParamsArray);
        }

        this.paramSets = [];
        this.params = {};
    },

    getResults: function Statement_getResults(aParams) {
        if (aParams)
            this.params = aParams;

        this._bindParams();

        var columnCount = this._wrappedStatement.columnCount;

        try {
            while (true) {
                let row = null;
                if (this._wrappedStatement.step()) {
                    row = {};
                    for (let i = 0; i < columnCount; i++) {
                        let column = this._wrappedStatement.getColumnName(i);
                        row[column] = this._wrappedStatement.row[column];
                    }
                }

                yield row;
            }
        }
        finally {
            this._wrappedStatement.reset();
        }
    },

    getSingleResult: function Statement_getSingleResult(aParams) {
        var results = this.getResults(aParams);
        var row = results.next();
        results.close();

        return row;
    },

    reset: function Statement_reset() {
        this.paramSets = [];
        this.params = {};
        this._wrappedStatement.reset();
    }

}


var Storage = {

    feedsAndFoldersCache: null,
    feedsCache:           null,

    ENTRY_STATE_NORMAL: 0,
    ENTRY_STATE_TRASHED: 1,
    ENTRY_STATE_DELETED: 2,
    ENTRY_STATE_ANY: 3,

    init: function Storage_init() {
        var profileDir = Cc['@mozilla.org/file/directory_service;1'].
                         getService(Ci.nsIProperties).
                         get('ProfD', Ci.nsIFile);
        var databaseFile = profileDir.clone();
        databaseFile.append('brief.sqlite');
        var databaseIsNew = !databaseFile.exists();

        var storageService = Cc['@mozilla.org/storage/service;1'].
                             getService(Ci.mozIStorageService);
        Connection = storageService.openUnsharedDatabase(databaseFile);
        var schemaVersion = Connection.schemaVersion;

        // Remove the backup file after certain amount of time.
        var backupFile = profileDir.clone();
        backupFile.append('brief-backup-' + (schemaVersion - 1) + '.sqlite');
        if (backupFile.exists() && Date.now() - backupFile.lastModifiedTime > BACKUP_FILE_EXPIRATION_AGE)
            backupFile.remove(false);

        if (!Connection.connectionReady) {
            // The database was corrupted, back it up and create a new one.
            storageService.backupDatabaseFile(databaseFile, 'brief-backup.sqlite');
            Connection.close();
            databaseFile.remove(false);
            Connection = storageService.openUnsharedDatabase(databaseFile);
            this.setupDatabase();
            Connection.schemaVersion = DATABASE_VERSION;
        }
        else if (databaseIsNew) {
            this.setupDatabase();
            Connection.schemaVersion = DATABASE_VERSION;
        }
        else if (Connection.schemaVersion < DATABASE_VERSION) {
            // Remove the old backup file.
            if (backupFile.exists())
                backupFile.remove(false);

            // Backup the database before migration.
            var newBackupFile = profileDir;
            var filename = 'brief-backup-' + schemaVersion + '.sqlite';
            newBackupFile.append(filename);
            if (!newBackupFile.exists())
                storageService.backupDatabaseFile(databaseFile, filename);

            Migration.upgradeDatabase();
        }

        this.homeFolderID = Prefs.getIntPref('homeFolder');
        Prefs.addObserver('', this, false);
        ObserverService.addObserver(this, 'quit-application', false);

        // This has to be on the end, in case getting bookmarks service throws.
        Bookmarks.addObserver(BookmarkObserver, false);
    },

    setupDatabase: function Storage_setupDatabase() {
        ExecuteSQL('CREATE TABLE IF NOT EXISTS feeds ('+FEEDS_TABLE_SCHEMA+')                   ');
        ExecuteSQL('CREATE TABLE IF NOT EXISTS entries ('+ENTRIES_TABLE_SCHEMA+')               ');
        ExecuteSQL('CREATE TABLE IF NOT EXISTS entry_tags ('+ENTRY_TAGS_TABLE_SCHEMA+')         ');
        ExecuteSQL('CREATE VIRTUAL TABLE entries_text USING fts3 ('+ENTRIES_TEXT_TABLE_SCHEMA+')');

        ExecuteSQL('CREATE INDEX IF NOT EXISTS entries_date_index ON entries (date)                ');
        ExecuteSQL('CREATE INDEX IF NOT EXISTS entries_feedID_date_index ON entries (feedID, date) ');

        // Speed up lookup when checking for updates.
        ExecuteSQL('CREATE INDEX IF NOT EXISTS entries_primaryHash_index ON entries (primaryHash) ');

        // Speed up SELECTs in the bookmarks observer.
        ExecuteSQL('CREATE INDEX IF NOT EXISTS entries_bookmarkID_index ON entries (bookmarkID) ');
        ExecuteSQL('CREATE INDEX IF NOT EXISTS entries_entryURL_index ON entries (entryURL)     ');

        ExecuteSQL('CREATE INDEX IF NOT EXISTS entry_tagName_index ON entry_tags (tagName)');
    },


    /**
     * Returns a feed or a folder with given ID.
     *
     * @param aFeedID
     * @returns Feed object, without entries.
     */
    getFeed: function Storage_getFeed(aFeedID) {
        var foundFeed = null;
        var feeds = this.getAllFeeds(true);
        for (var i = 0; i < feeds.length; i++) {
            if (feeds[i].feedID == aFeedID) {
                foundFeed = feeds[i];
                break;
            }
        }
        return foundFeed;
    },

    /**
     * Gets all feeds, without entries.
     *
     * @param aIncludeFolders [optional]
     * @returns array of Feed's.
     */
    getAllFeeds: function Storage_getAllFeeds(aIncludeFolders) {
        if (!this.feedsCache)
            this.buildFeedsCache();

        return aIncludeFolders ? this.feedsAndFoldersCache : this.feedsCache;
    },

    buildFeedsCache: function Storage_buildFeedsCache() {
        this.feedsCache = [];
        this.feedsAndFoldersCache = [];

        var results = Stm.getAllFeeds.getResults();
        for (let row = results.next(); row; row = results.next()) {

            let feed = new Feed();
            for (let column in row)
                feed[column] = row[column];

            this.feedsAndFoldersCache.push(feed);
            if (!feed.isFolder)
                this.feedsCache.push(feed);
        }
        results.close();
    },

    /**
     * Gets a list of distinct tags for URLs of entries stored in the database.
     *
     * @returns Array of tag names.
     */
    getAllTags: function Storage_getAllTags() {
        var tags = [];

        var results = Stm.getAllTags.getResults();
        for (row = results.next(); row; row = results.next())
            tags.push(row.tagName);
        results.close();

        return tags;
    },


    /**
     * Evaluates provided entries, inserting any new items and updating existing
     * items when newer versions are found. Also updates feed's properties.
     *
     * @param aFeed
     *        Contains the feed and the entries to evaluate.
     * @param aCallback
     *        Callback after the database is updated.
     */
    processFeed: function Storage_processFeed(aFeed, aCallback) {
        new FeedProcessor(aFeed, aCallback);
    },

    /**
     * Saves feed settings: entryAgeLimit, maxEntries, updateInterval and
     * markModifiedEntriesUnread.
     *
     * @param aFeed
     *        Feed object whose properties to use to update the respective
     *        columns in the database.
     */
    setFeedOptions: function Storage_setFeedOptions(aFeed) {
        Stm.setFeedOptions.execute({
            'entryAgeLimit': aFeed.entryAgeLimit,
            'maxEntries': aFeed.maxEntries,
            'updateInterval': aFeed.updateInterval,
            'markUnread': aFeed.markModifiedEntriesUnread ? 1 : 0,
            'feedID': aFeed.feedID
        });

        // Update the cache if neccassary (it may not be if Feed instance that was
        // passed to us was itself taken from the cache).
        var feed = this.getFeed(aFeed.feedID);
        if (feed != aFeed) {
            feed.entryAgeLimit = aFeed.entryAgeLimit;
            feed.maxEntries = aFeed.maxEntries;
            feed.updateInterval = aFeed.updateInterval;
            feed.markModifiedEntriesUnread = aFeed.markModifiedEntriesUnread;
        }
    },


    /**
     * Physically removes all deleted items and runs SQL VACUUM command to reclaim
     * disc space and defragment the database.
     */
    compactDatabase: function Storage_compactDatabase() {
        this.purgeEntries(false);
        ExecuteSQL('VACUUM');
    },


    // Moves expired entries to Trash and permanently removes
    // the deleted items from database.
    purgeEntries: function Storage_purgeEntries(aDeleteExpired) {
        Connection.beginTransaction()
        try {
            if (aDeleteExpired) {
                // Delete old entries in feeds that don't have per-feed setting enabled.
                if (Prefs.getBoolPref('database.expireEntries')) {
                    let expirationAge = Prefs.getIntPref('database.entryExpirationAge');

                    Stm.expireEntriesByAgeGlobal.execute({
                        'oldState': Storage.ENTRY_STATE_NORMAL,
                        'newState': Storage.ENTRY_STATE_TRASHED,
                        'edgeDate': Date.now() - expirationAge * 86400000
                    });
                }

                // Delete old entries based on per-feed limit.
                for each (let feed in this.getAllFeeds()) {
                    if (feed.entryAgeLimit > 0) {
                        Stm.expireEntriesByAgePerFeed.execute({
                            'oldState': Storage.ENTRY_STATE_NORMAL,
                            'newState': Storage.ENTRY_STATE_TRASHED,
                            'edgeDate': Date.now() - feed.entryAgeLimit * 86400000,
                            'feedID': feed.feedID
                        });
                    }
                }

                // Delete entries exceeding the maximum amount specified by maxStoredEntries pref.
                if (Prefs.getBoolPref('database.limitStoredEntries')) {
                    let maxEntries = Prefs.getIntPref('database.maxStoredEntries');

                    for each (let feed in this.getAllFeeds()) {
                        let row = Stm.getDeletedEntriesCount.getSingleResult({
                            'feedID': feed.feedID,
                            'deletedState': Storage.ENTRY_STATE_NORMAL
                        })

                        if (row.entryCount - maxEntries > 0) {
                            Stm.expireEntriesByNumber.execute({
                                'oldState': Storage.ENTRY_STATE_NORMAL,
                                'newState': Storage.ENTRY_STATE_TRASHED,
                                'feedID': feed.feedID,
                                'limit': row.entryCount - maxEntries
                            });
                        }
                    }
                }
            }

            Stm.purgeDeletedEntriesText.execute({
                'deletedState': Storage.ENTRY_STATE_DELETED,
                'currentDate': Date.now(),
                'retentionTime': DELETED_FEEDS_RETENTION_TIME
            });

            Stm.purgeDeletedEntries.execute({
                'deletedState': Storage.ENTRY_STATE_DELETED,
                'currentDate': Date.now(),
                'retentionTime': DELETED_FEEDS_RETENTION_TIME
            });

            Stm.purgeDeletedFeeds.execute({
                'currentDate': Date.now(),
                'retentionTime': DELETED_FEEDS_RETENTION_TIME
            });
        }
        catch (ex) {
            ReportError(ex);
        }
        finally {
            Connection.commitTransaction();
        }

        // Prefs can only store longs while Date is a long long.
        var now = Math.round(Date.now() / 1000);
        Prefs.setIntPref('database.lastPurgeTime', now);
    },

    // nsIObserver
    observe: function Storage_observe(aSubject, aTopic, aData) {
        switch (aTopic) {
            case 'quit-application':
                // Integer prefs are longs while Date is a long long.
                var now = Math.round(Date.now() / 1000);
                var lastPurgeTime = Prefs.getIntPref('database.lastPurgeTime');
                if (now - lastPurgeTime > PURGE_ENTRIES_INTERVAL)
                    this.purgeEntries(true);

                Bookmarks.removeObserver(BookmarkObserver);
                Prefs.removeObserver('', this);
                ObserverService.removeObserver(this, 'quit-application');

                BookmarkObserver.syncDelayTimer = null;
                break;

            case 'nsPref:changed':
                if (aData == 'homeFolder') {
                    this.homeFolderID = Prefs.getIntPref('homeFolder');
                    this.syncWithLivemarks();
                }
                break;
        }
    },


    /**
     * Synchronizes database with Live Bookmarks from home folder which ID is
     * specified by extensions.brief.homeFolder.
     * Feeds that were removed from the home folder remain in the database in the hidden
     * state for a certain amount of time in case they are added back.
     */
    syncWithLivemarks: function Storage_syncWithLivemarks() {
        new LivemarksSync();
    },

    observers: [],

    /**
     * Registers an object to be notified of entry changes. Storage keeps a strong
     * reference to this object, so all observers have to be removed using
     * Storage.removeObserver().
     *
     * Observer must implement the following functions.
     *
     * Called when new entries are added to the database.
     *
     *     function onEntriesAdded(aEntryList)
     *
     * Called when properties of existing entries, such as title, content, authors
     * and date, are changed. When entries are updated, they can also be marked as unread.
     *
     *     function onEntriesUpdated(aEntryList);
     *
     * Called when the read/unread state of entries changes.
     *
     *     function onEntriesMarkedRead(aEntryList, aNewState);
     *
     * Called when URLs of entries are bookmarked/unbookmarked.
     *
     *     function onEntriesStarred(aEntryList, aNewState);
     *
     * Called when a tag is added or removed from entries.
     *
     *     function onEntriesTagged(aEntryList, aNewState, aTagName);
     *
     * Called when the deleted state of entries changes.
     *
     *     function onEntriesDeleted(aEntryList, aNewState);
     *
     */
    addObserver: function Storage_addObserver(aObserver) {
        this.observers.push(aObserver);
    },

    /**
     * Unregisters an observer object.
     */
    removeObserver: function Storage_removeObserver(aObserver) {
        var index = this.observers.indexOf(aObserver);
        if (index !== -1)
            this.observers.splice(index, 1);
    },

    /**
     * Sets starred status of an entry.
     *
     * @param aState      New state. TRUE for starred, FALSE for not starred.
     * @param aEntryID    Subject entry.
     * @param aBookmarkID ItemId of the corresponding bookmark in Places database.
     */
    starEntry: function Storage_starEntry(aState, aEntryID, aBookmarkID, aDontNotify) {
        if (aState)
            Stm.starEntry.execute({ 'bookmarkID': aBookmarkID, 'entryID': aEntryID });
        else
            Stm.unstarEntry.execute({ 'id': aEntryID });

        if (aDontNotify)
            return;

        // Notify observers.
        var list = new Query([aEntryID]).getEntryList();
        for each (let observer in this.observers)
            observer.onEntriesStarred(list, aState);
    },

    /**
     * Adds or removes a tag for an entry.
     *
     * @param aState   TRUE to add the tag, FALSE to remove it.
     * @param aEntryID Subject entry.
     * @param aTagName Name of the tag.
     * @param aTagID   ItemId of the tag's bookmark item in Places database. Only
     *                 required when adding a tag.
     */
    tagEntry: function Storage_tagEntry(aState, aEntryID, aTagName, aTagID) {
        if (aState) {
            Stm.tagEntry.execute({
                'entryID': aEntryID,
                'tagName': aTagName,
                'tagID': aTagID
            });
        }
        else {
            Stm.untagEntry.execute({
                'entryID': aEntryID,
                'tagName': aTagName
            });
        }

        // Update the serialized list of tags stored in entries_text table.
        Stm.setSerializedTagList.execute({
            'tags': Utils.getTagsForEntry(aEntryID).join(', '),
            'entryID': aEntryID
        });

        // Notify observers.
        var list = new Query([aEntryID]).getEntryList();
        for each (let observer in this.observers)
            observer.onEntriesTagged(list, aState, aTagName);
    },

    QueryInterface: XPCOMUtils.generateQI(Ci.nsIObserver)

}


/**
 * Evaluates the provided entries, inserting any new items and updating existing
 * items when newer versions are found. Also updates feed's properties.
 */
function FeedProcessor(aFeed, aCallback) {
    this.feed = aFeed;
    this.callback = aCallback;

    this.remainingEntriesCount = aFeed.entries.length;

    this.updatedEntries = [];
    this.insertedEntries = [];

    var newDateModified = new Date(aFeed.wrappedFeed.updated).getTime();
    var prevDateModified = Storage.getFeed(aFeed.feedID).dateModified;

    if (aFeed.entries.length && (!newDateModified || newDateModified > prevDateModified)) {
        aFeed.oldestEntryDate = Date.now();

        for (let i = 0; i < aFeed.entries.length; i++) {
            let entry = aFeed.entries[i];
            this.processEntry(entry);

            if (entry.date && entry.date < aFeed.oldestEntryDate)
                aFeed.oldestEntryDate = entry.date;
        }
    }
    else {
        aCallback(0);
    }

    var properties = {
        'websiteURL': aFeed.websiteURL,
        'subtitle': aFeed.subtitle,
        'favicon': aFeed.favicon,
        'lastUpdated': Date.now(),
        'dateModified': newDateModified,
        'oldestEntryDate': aFeed.oldestEntryDate,
        'feedID': aFeed.feedID
    }

    Stm.updateFeed.params = properties;
    Stm.updateFeed.executeAsync();

    // Keep cache up to date.
    var cachedFeed = Storage.getFeed(aFeed.feedID);
    for (let p in properties)
        cachedFeed[p] = properties[p];
}

FeedProcessor.prototype = {

    entriesToUpdateCount: 0,
    entriesToInsertCount: 0,

    processEntry: function FeedProcessor_processEntry(aEntry) {
        // This function checks whether a downloaded entry is already in the database or
        // it is a new one. To do this we need a way to uniquely identify entries. Many
        // feeds don't provide unique identifiers for their entries, so we have to use
        // hashes for this purpose. There are two hashes.
        // The primary hash is used as a standard unique ID throughout the codebase.
        // Ideally, we just compute it from the GUID provided by the feed. Otherwise, we
        // use the entry's URL.
        // There is a problem, though. Even when a feed does provide its own GUID, it
        // seems to randomly get lost (maybe a bug in the parser?). This means that the
        // same entry may sometimes be hashed using the GUID and other times using the
        // URL. Different hashes lead to the entry being duplicated.
        // This is why we need a secondary hash, which is always based on the URL. If the
        // GUID is empty (either because it was lost or because it wasn't provided to
        // begin with), we look up the entry using the secondary hash.
        var providedID = aEntry.wrappedEntry.id;
        var primarySet = providedID ? [this.feed.feedID, providedID]
                                    : [this.feed.feedID, aEntry.entryURL];
        var secondarySet = [this.feed.feedID, aEntry.entryURL];

        // Special case for MediaWiki feeds: include the date in the hash. In
        // "Recent changes" feeds, entries for subsequent edits of a page differ
        // only in date (not in URL or GUID).
        var generator = this.feed.wrappedFeed.generator;
        if (generator && generator.agent.match('MediaWiki')) {
            primarySet.push(aEntry.date);
            secondarySet.push(aEntry.date);
        }

        var primaryHash = Utils.hashString(primarySet.join(''));
        var secondaryHash = Utils.hashString(secondarySet.join(''));

        // Look up if the entry is already present in the database.
        if (providedID) {
            var select = Stm.getEntryByPrimaryHash;
            select.params.primaryHash = primaryHash;
        }
        else {
            select = Stm.getEntryBySecondaryHash;
            select.params.secondaryHash = secondaryHash;
        }

        var storedID, storedDate, isEntryRead;
        var self = this;

        select.executeAsync({
            handleResult: function(aResultSet) {
                var row = aResultSet.getNextRow();
                storedID = row.getResultByIndex('id');
                storedDate = row.getResultByName('date');
                isEntryRead = row.getResultByName('read');
            },

            handleCompletion: function(aReason) {
                if (aReason == REASON_FINISHED) {
                    if (storedID) {
                        if (aEntry.date && storedDate < aEntry.date) {
                            self.addUpdateParams(aEntry, storedID, isEntryRead);
                        }
                    }
                    else {
                        self.addInsertParams(aEntry, primaryHash, secondaryHash);
                    }
                }

                self.remainingEntriesCount--;
                if (!self.remainingEntriesCount)
                    self.exacuteAndNotify();
            }
        });
    },

    addUpdateParams: function FeedProcessor_addUpdateParams(aEntry, aStoredEntryID, aIsRead) {
        var title = aEntry.title ? aEntry.title.replace(/<[^>]+>/g, '') : ''; // Strip tags
        var markUnread = Storage.getFeed(this.feed.feedID).markModifiedEntriesUnread;

        Stm.updateEntry.paramSets.push({
            'date': aEntry.date,
            'read': markUnread || !aIsRead ? 0 : 1,
            'id': aStoredEntryID
        });

        Stm.updateEntryText.paramSets.push({
            'title': title,
            'content': aEntry.content || aEntry.summary,
            'authors': aEntry.authors,
            'id': aStoredEntryID
        });

        this.entriesToUpdateCount++;
        this.updatedEntries.push(aStoredEntryID);
    },

    addInsertParams: function FeedProcessor_addInsertParams(aEntry, aPrimaryHash, aSecondaryHash) {
        var title = aEntry.title ? aEntry.title.replace(/<[^>]+>/g, '') : ''; // Strip tags

        Stm.insertEntry.paramSets.push({
            'feedID': this.feed.feedID,
            'primaryHash': aPrimaryHash,
            'secondaryHash': aSecondaryHash,
            'providedID': aEntry.wrappedEntry.id,
            'entryURL': aEntry.entryURL,
            'date': aEntry.date || Date.now()
        });

        Stm.insertEntryText.paramSets.push({
            'title': title,
            'content': aEntry.content || aEntry.summary,
            'authors': aEntry.authors
        });

        this.entriesToInsertCount++;
    },

    exacuteAndNotify: function FeedProcessor_exacuteAndNotify() {
        var self = this;

        if (this.entriesToInsertCount) {
            Stm.getLastRowids.params.count = this.entriesToInsertCount;
            let statements = [Stm.insertEntry, Stm.insertEntryText, Stm.getLastRowids];

            ExecuteStatementsAsync(statements, {

                handleResult: function(aResultSet) {
                    var row;
                    while (row = aResultSet.getNextRow()) {
                        let entryID = row.getResultByIndex(0);
                        self.insertedEntries.push(entryID);
                    }
                },

                handleCompletion: function(aReason) {
                    var list = new Query(self.insertedEntries).getEntryList();
                    for each (let observer in Storage.observers)
                        observer.onEntriesAdded(list);

                    // XXX This should be optimized and/or be asynchronous
                    // query.verifyBookmarksAndTags();
                }
            });
        }

        if (this.entriesToUpdateCount) {
            let statements = [Stm.updateEntry, Stm.updateEntryText];

            ExecuteStatementsAsync(statements, {

                handleCompletion: function(aReason) {
                    var list = new Query(self.updatedEntries).getEntryList();
                    for each (let observer in Storage.observers)
                        observer.onEntriesUpdated(list);
                }
            });
        }

        this.callback(this.entriesToInsertCount);
    }
}


/**
 * A query to the Brief's database. Constraints are AND-ed.
 */
function Query(aEntries) {
    this.entries = aEntries;
}

Query.prototype = {

    /**
     * Array of IDs of entries to be selected.
     */
    entries: null,

    /**
     * Array of IDs of feeds containing the entries to be selected.
     */
    feeds: null,

    /**
     * Array of IDs of folders containing the entries to be selected.
     */
    folders: null,

    /**
     * Array of tags which selected entries must have.
     */
    tags: null,

    /**
     * Entry status. Set any of these attributes to TRUE to limit query to entries with
     * respetive status.
     */
    read: false,
    unread: false,
    starred: false,
    unstarred: false,

    /**
     * Deleted state of entries to be selected. See constants in Storage.
     */
    deleted: Storage.ENTRY_STATE_ANY,

    /**
     * String that must be contained by title, content, authors or tags of the
     * selected entries.
     */
    searchString: '',

    /**
     * Date range for the selected entries.
     */
    startDate: 0,
    endDate:   0,

    /**
     * Maximum number of entries to be selected. Default value is 0 - unlimited.
     */
    limit:  0,

    /**
     * Specifies how many result entries to skip at the beggining of the result set.
     */
    offset: 0,

    /**
     * By which column to sort the results.
     */
    NO_SORT: 0,
    SORT_BY_DATE: 1,
    SORT_BY_TITLE: 2,
    SORT_BY_FEED_ROW_INDEX: 3,

    sortOrder: 0,

    /**
     * Direction in which to sort the results.
     */
    SORT_DESCENDING: 0,
    SORT_ASCENDING: 1,

    sortDirection: 0,

    /**
     * Include hidden feeds i.e. the ones whose Live Bookmarks are no longer
     * to be found in Brief's home folder. This attribute is ignored if
     * the list of feeds is explicitly specified by Query.feeds.
     */
    includeHiddenFeeds: false,

    /**
     * Actual list of folders selected by the query, including subfolders
     * of folders specified by Query.folders.
     */
    effectiveFolders: null,


    /**
     * Indicates if there are any entries that match this query.
     */
    hasMatches: function Query_hasMatches() {
        try {
            var sql = 'SELECT EXISTS (SELECT entries.id ' + this.getQueryString(true) + ') AS found';
            var select = CreateStatement(sql);
            select.step();
            var exists = select.row.found;
        }
        catch (ex) {
            if (Connection.lastError != 1) ReportError(ex, true);
        }
        finally {
            select.reset();
        }

        return exists;
    },

    /**
     * Returns a list of IDs of selected entries.
     *
     * @returns Array if IDs of selected entries.
     */
    getEntries: function Query_getEntries() {
        try {
            var sql = 'SELECT entries.id ' + this.getQueryString(true);
            var select = CreateStatement(sql);
            var entries = [];
            while (select.step())
                entries.push(select.row.id);
        }
        catch (ex) {
            if (Connection.lastError != 1) ReportError(ex, true);
        }
        finally {
            select.reset();
        }

        return entries;
    },


    /**
     * Returns the selected entries with all their properties.
     *
     * @returns Array of Entry's.
     */
    getFullEntries: function Query_getFullEntries() {
        var sql = 'SELECT entries.id, entries.feedID, entries.entryURL, entries.date,   '+
                  '       entries.read, entries.starred, entries.updated,               '+
                  '       entries.bookmarkID, entries_text.title, entries_text.content, '+
                  '       entries_text.authors, entries_text.tags                       ';
        sql += this.getQueryString(true, true);
        var select = CreateStatement(sql);

        var entries = [];
        try {
            while (select.step()) {
                var entry = new Entry();

                entry.id = select.row.id;
                entry.feedID = select.row.feedID;
                entry.entryURL = select.row.entryURL;
                entry.date = select.row.date;
                entry.authors = select.row.authors;
                entry.read = select.row.read;
                entry.starred = select.row.starred;
                entry.updated = select.row.updated;
                entry.bookmarkID = select.row.bookmarkID;
                entry.title = select.row.title;
                entry.content = select.row.content;
                entry.tags = select.row.tags;

                entries.push(entry);
            }
        }
        catch (ex) {
            // Ignore "SQL logic error or missing database" error which full-text search
            // throws when the query doesn't contain at least one non-excluded term.
            if (Connection.lastError != 1) ReportError(ex, true);
        }
        finally {
            select.reset();
        }

        return entries;
    },


    /**
     * Returns value of a property for each of the selected entries.
     *
     * @param aPropertyName
     *        Name of the property.
     * @param aDistinct
     *        Don't include multiple entries with the same value.
     * @returns Array of objects containing the requested property
     *          and ID of the corresponding entry.
     */
    getProperty: function Query_getProperty(aPropertyName, aDistinct) {
        var rows = [];
        var values = [];

        switch (aPropertyName) {
            case 'content':
            case 'title':
            case 'authors':
            case 'tags':
                var table = 'entries_text.';
                var getEntriesText = true;
                break;
            default:
                table = 'entries.';
        }

        try {
            var select = CreateStatement('SELECT entries.id, ' + table + aPropertyName +
                                         this.getQueryString(true, getEntriesText));

            while (select.step()) {
                let propertyValue = select.row[aPropertyName];
                if (aDistinct && values.indexOf(propertyValue) != -1)
                    continue;

                values.push(propertyValue);

                let row = { };
                row[aPropertyName] = propertyValue;
                row.ID = select.row.id;
                rows.push(row);
            }
        }
        catch (ex) {
            if (Connection.lastError != 1) ReportError(ex, true);
        }
        finally {
            select.reset();
        }

        return rows;
    },


    /**
     * Returns the number of selected entries.
     */
    getEntryCount: function Query_getEntryCount() {
        // Optimization: ignore sorting settings.
        var tempOrder = this.sortOrder;
        this.sortOrder = this.NO_SORT;
        var select = CreateStatement('SELECT COUNT(1) AS count ' + this.getQueryString(true));
        this.sortOrder = tempOrder;

        try {
            select.step();
            var count = select.row.count;
        }
        catch (ex) {
            if (Connection.lastError != 1) ReportError(ex, true);
        }
        finally {
            select.reset();
        }

        return count;
    },


    /**
     * Used to get EntryList of changed entries, so that it can be passed to observers.
     */
    getEntryList: function Query_getEntryList() {
        try {
            var entryIDs = [];
            var feedIDs = [];
            var tags = [];

            var tempHidden = this.includeHiddenFeeds;
            this.includeHiddenFeeds = false;

            var sql = 'SELECT entries.id, entries.feedID, entries_text.tags ';
            var select = CreateStatement(sql + this.getQueryString(true, true));
            while (select.step()) {
                entryIDs.push(select.row.id);

                let feedID = select.row.feedID;
                if (feedIDs.indexOf(feedID) == -1)
                    feedIDs.push(feedID);

                let tagSet = select.row.tags;
                if (tagSet) {
                    tagSet = tagSet.split(', ');
                    for (let i = 0; i < tagSet.length; i++) {
                        if (tags.indexOf(tagSet[i]) == -1)
                            tags.push(tagSet[i]);
                    }
                }
            }
        }
        catch (ex) {
            if (Connection.lastError != 1) ReportError(ex, true);
        }
        finally {
            select.reset();
            this.includeHiddenFeeds = tempHidden;
        }

        var list = new EntryList();
        list.IDs = entryIDs;
        list.feedIDs = feedIDs;
        list.tags = tags;

        return list;
    },


    /**
     * Marks selected entries as read/unread.
     *
     * @param aState
     *        New state of entries (TRUE for read, FALSE for unread).
     */
    markEntriesRead: function Query_markEntriesRead(aState) {
        // We try not to include entries which already have the desired state,
        // but we can't omit them if a specific range of the selected entries
        // is meant to be marked.
        var tempRead = this.read;
        var tempUnread = this.unread;
        if (!this.limit && !this.offset) {
            this.read = !aState;
            this.unread = aState;
        }

        var update = CreateStatement('UPDATE entries SET read = :read, updated = 0 ' +
                                     this.getQueryString())
        update.params.read = aState ? 1 : 0;

        Connection.beginTransaction();
        try {
            var list = this.getEntryList();
            update.execute();
        }
        catch (ex) {
            if (Connection.lastError != 1) ReportError(ex, true);
        }
        finally {
            this.unread = tempUnread;
            this.read = tempRead;

            Connection.commitTransaction();
        }

        if (list.length) {
            for each (let observer in Storage.observers)
                observer.onEntriesMarkedRead(list, aState);
        }
    },

    /**
     * Sets the deleted state of the selected entries or removes them from the database.
     *
     * @param aState
     *        The new deleted state (as defined by constants in Storage.deleted)
     *        or instruction to physically remove the entries from the
     *        database (REMOVE_FROM_DATABASE constant below).
     *
     * @throws NS_ERROR_INVALID_ARG on invalid |aState| parameter.
     */
    REMOVE_FROM_DATABASE: 4,

    deleteEntries: function Query_deleteEntries(aState) {
        switch (aState) {
            case Storage.ENTRY_STATE_NORMAL:
            case Storage.ENTRY_STATE_TRASHED:
            case Storage.ENTRY_STATE_DELETED:
                var statement = CreateStatement('UPDATE entries SET deleted = ' +aState+
                                                 this.getQueryString());
                break;
            case this.REMOVE_FROM_DATABASE:
                var statement = CreateStatement('DELETE FROM entries ' + this.getQueryString());
                break;
            default:
                throw Components.results.NS_ERROR_INVALID_ARG;
        }

        Connection.beginTransaction();
        try {
            var list = this.getEntryList();
            statement.execute();
        }
        catch (ex) {
            if (Connection.lastError != 1) ReportError(ex, true);
        }
        finally {
            Connection.commitTransaction();
        }

        if (list.length) {
            for each (let observer in Storage.observers)
                observer.onEntriesDeleted(list, aState);
        }
    },


    /**
     * Bookmarks or unbookmarks URLs of the selected entries.
     *
     * @param state
     *        New state of entries. TRUE to bookmark, FALSE to unbookmark.
     *
     * This function bookmarks URIs of the selected entries. It doesn't star the entries
     * in the database or send notifications - that part is performed by the bookmark
     * observer.
     */
    starEntries: function Query_starEntries(aState) {
        var transSrv = Cc['@mozilla.org/browser/placesTransactionsService;1'].
                       getService(Ci.nsIPlacesTransactionsService);
        var transactions = []

        for each (let entry in this.getFullEntries()) {
            let uri = Utils.newURI(entry.entryURL);
            if (!uri)
                continue;

            if (aState) {
                let trans = transSrv.createItem(uri, Places.unfiledBookmarksFolderId,
                                                Bookmarks.DEFAULT_INDEX, entry.title);
                transactions.push(trans);
            }
            else {
                let bookmarks = Bookmarks.getBookmarkIdsForURI(uri, {})
                                         .filter(Utils.isNormalBookmark);
                if (bookmarks.length) {
                    for (let i = bookmarks.length - 1; i >= 0; i--) {
                        let trans = transSrv.removeItem(bookmarks[i]);
                        transactions.push(trans);
                    }
                }
                else {
                    // If there are no bookmarks for an URL that is starred in our
                    // database, it means that the database is out of sync and we
                    // must update the database directly.
                    Storage.starEntry(false, entry.id, bookmarks[0]);
                }
            }
        }

        var aggregatedTrans = transSrv.aggregateTransactions('', transactions);
        transSrv.doTransaction(aggregatedTrans);
    },

    /**
     * The starred status of entries is automatically kept in sync with user's bookmarks
     * by the storage service. However, there's always a possibility that it goes out of
     * sync, for example while Brief is disabled or uninstalled. This method verifies
     * status of the selected entries.
     * If an entry is starred, but no bookmarks are found for its URI, then a new bookmark
     * is added. If an entry isn't starred, but there is a bookmark for its URI, this
     * function stars the entry. Tags are verified in the same manner.
     *
     * @returns TRUE if the starred status was in sync, FALSE otherwise.
     */
    verifyBookmarksAndTags: function Query_verifyBookmarksAndTags() {
        var statusOK = true;

        for each (let entry in this.getFullEntries()) {
            let uri = Utils.newURI(entry.entryURL);
            if (!uri)
                continue;

            let allBookmarks = Bookmarks.getBookmarkIdsForURI(uri, {});

            // Verify bookmarks.
            let normalBookmarks = allBookmarks.filter(Utils.isNormalBookmark);
            if (entry.starred && !normalBookmarks.length) {
                new Query([entry.id]).starEntries(true);
                statusOK = false;
            }
            else if (!entry.starred && normalBookmarks.length) {
                Storage.starEntry(true, entry.id, normalBookmarks[0]);
                statusOK = false;
            }

            // Verify tags.
            var storedTags = Utils.getTagsForEntry(entry.id);

            // Get the list of current tags for this entry's URI.
            var currentTagNames = [];
            var currentTagIDs = [];
            for each (let itemID in allBookmarks) {
                let parent = Bookmarks.getFolderIdForItem(itemID);
                if (Utils.isTagFolder(parent)) {
                    currentTagIDs.push(itemID);
                    currentTagNames.push(Bookmarks.getItemTitle(parent));
                }
            }

            for each (let tag in storedTags) {
                if (currentTagNames.indexOf(tag) === -1) {
                    Places.tagging.tagURI(uri, [tag]);
                    statusOK = false;
                }
            }

            for (let i = 0; i < currentTagNames.length; i++) {
                let tag = currentTagNames[i];
                if (storedTags.indexOf(tag) === -1) {
                    Storage.tagEntry(true, entry.id, tag, currentTagIDs[i])
                    statusOK = false;
                }
            }
        }

        return statusOK;
    },

    /**
     * Constructs SQL query constraints query's properties.
     *
     * @param aForSelect      Build a string optimized for a SELECT statement.
     * @param aGetFullEntries Forces including entries_text table (otherwise, it is
     *                        included only when it is used by the query constraints).
     * @returns String containing the part of an SQL statement after WHERE clause.
     */
    getQueryString: function Query_getQueryString(aForSelect, aGetFullEntries) {
        var text = aForSelect ? ' FROM entries '
                              : ' WHERE entries.id IN (SELECT entries.id FROM entries ';

        if (!this.feeds && !this.includeHiddenFeeds)
            text += ' INNER JOIN feeds ON entries.feedID = feeds.feedID ';

        if (aGetFullEntries || this.searchString || this.sortOrder == this.SORT_BY_TITLE)
            text += ' INNER JOIN entries_text ON entries.id = entries_text.rowid ';

        if (this.tags)
            text += ' INNER JOIN entry_tags ON entries.id = entry_tags.entryID ';

        var constraints = [];

        if (this.folders) {
            if (!this.folders.length)
                throw Components.results.NS_ERROR_INVALID_ARG;

            /**
             * Compute the actual list of folders to be selected, including subfolders
             * of folders specified by Query.folders.
             */
            this.effectiveFolders = this.folders;
            this.traverseFolderChildren(Storage.homeFolderID);

            let con = '(feeds.parent = "';
            con += this.effectiveFolders.join('" OR feeds.parent = "');
            con += '")';
            constraints.push(con);
        }

        if (this.feeds) {
            if (!this.feeds.length)
                throw Components.results.NS_ERROR_INVALID_ARG;

            let con = '(entries.feedID = "';
            con += this.feeds.join('" OR entries.feedID = "');
            con += '")';
            constraints.push(con);
        }

        if (this.entries) {
            if (!this.entries.length)
                throw Components.results.NS_ERROR_INVALID_ARG;

            let con = '(entries.id = ';
            con += this.entries.join(' OR entries.id = ');
            con += ')';
            constraints.push(con);
        }

        if (this.tags) {
            if (!this.tags.length)
                throw Components.results.NS_ERROR_INVALID_ARG;

            let con = '(entry_tags.tagName = "';
            con += this.tags.join('" OR entry_tags.tagName = "');
            con += '")';
            constraints.push(con);
        }

        if (this.searchString) {
            let con = 'entries_text MATCH \'' + this.searchString.replace("'",' ') + '\'';
            constraints.push(con);
        }

        if (this.read)
            constraints.push('entries.read = 1');
        if (this.unread)
            constraints.push('entries.read = 0');
        if (this.starred)
            constraints.push('entries.starred = 1');
        if (this.unstarred)
            constraints.push('entries.starred = 0');

        if (this.deleted != Storage.ENTRY_STATE_ANY)
            constraints.push('entries.deleted = ' + this.deleted);

        if (this.startDate > 0)
            constraints.push('entries.date >= ' + this.startDate);
        if (this.endDate > 0)
            constraints.push('entries.date <= ' + this.endDate);

        if (!this.includeHiddenFeeds && !this.feeds)
            constraints.push('feeds.hidden = 0');

        if (constraints.length)
            text += ' WHERE ' + constraints.join(' AND ') + ' ';

        if (this.sortOrder != this.NO_SORT) {
            switch (this.sortOrder) {
                case this.SORT_BY_FEED_ROW_INDEX:
                    var sortOrder = 'feeds.rowIndex ';
                    break;
                case this.SORT_BY_DATE:
                    sortOrder = 'entries.date ';
                    break;
                case this.SORT_BY_TITLE:
                    sortOrder = 'entries_text.title ';
                    break;
                default:
                    throw Components.results.NS_ERROR_ILLEGAL_VALUE;
            }

            var sortDir = (this.sortDirection == this.SORT_ASCENDING) ? 'ASC' : 'DESC';
            text += 'ORDER BY ' + sortOrder + sortDir;

            // Sort by rowid, so that entries that are equal in respect of primary
            // sorting criteria are always returned in the same (as opposed to
            // undefined) order.
            text += ', entries.rowid ' + sortDir;
        }

        if (this.limit)
            text += ' LIMIT ' + this.limit;
        if (this.offset > 1)
            text += ' OFFSET ' + this.offset;

        if (!aForSelect)
            text += ') ';

        return text;
    },

    traverseFolderChildren: function Query_traverseFolderChildren(aFolder) {
        var isEffectiveFolder = (this.effectiveFolders.indexOf(aFolder) != -1);
        var items = Storage.getAllFeeds(true);

        for (var i = 0; i < items.length; i++) {
            if (items[i].parent == aFolder && items[i].isFolder) {
                if (isEffectiveFolder)
                    this.effectiveFolders.push(items[i].feedID);
                this.traverseFolderChildren(items[i].feedID);
            }
        }
    }

}


var Migration = {

    upgradeDatabase: function Migration_upgradeDatabase() {
        switch (Connection.schemaVersion) {

        // Schema version checking has only been introduced in 0.8 beta 1. When migrating
        // from earlier releases we don't know the exact previous version, so we attempt
        // to apply all the changes since the beginning of time.
        case 0:
            try {
                // Columns added in 0.6.
                ExecuteSQL('ALTER TABLE feeds ADD COLUMN oldestAvailableEntryDate INTEGER');
                ExecuteSQL('ALTER TABLE entries ADD COLUMN providedID TEXT');
            }
            catch (ex) { }

            try {
                // Columns and indices added in 0.7.
                ExecuteSQL('ALTER TABLE feeds ADD COLUMN lastUpdated INTEGER');
                ExecuteSQL('ALTER TABLE feeds ADD COLUMN updateInterval INTEGER DEFAULT 0');
                ExecuteSQL('ALTER TABLE feeds ADD COLUMN entryAgeLimit INTEGER DEFAULT 0');
                ExecuteSQL('ALTER TABLE feeds ADD COLUMN maxEntries INTEGER DEFAULT 0');
                ExecuteSQL('ALTER TABLE entries ADD COLUMN authors TEXT');
                ExecuteSQL('ALTER TABLE feeds ADD COLUMN rowIndex INTEGER');
                ExecuteSQL('ALTER TABLE feeds ADD COLUMN parent TEXT');
                ExecuteSQL('ALTER TABLE feeds ADD COLUMN isFolder INTEGER');
                ExecuteSQL('ALTER TABLE feeds ADD COLUMN RDF_URI TEXT');
            }
            catch (ex) { }
            // Fall through...

        // To 0.8.
        case 1:
            ExecuteSQL('ALTER TABLE entries ADD COLUMN secondaryID TEXT');
            ExecuteSQL('UPDATE entries SET content = summary, summary = "" WHERE content = ""');
            // Fall through...

        // To 1.0 beta 1
        case 2:
            try {
                ExecuteSQL('ALTER TABLE entries ADD COLUMN updated INTEGER DEFAULT 0');
            }
            catch (ex) { }
            // Fall through...

        // To 1.0
        case 3:
            ExecuteSQL('DROP INDEX IF EXISTS entries_id_index');
            ExecuteSQL('DROP INDEX IF EXISTS feeds_feedID_index');
            // Fall through...

        // To 1.2a1
        case 4:
            this.recomputeIDs();
            this.recreateFeedsTable();
            ExecuteSQL('ALTER TABLE entries ADD COLUMN bookmarkID INTEGER DEFAULT -1');
            // Fall through...

        // To 1.2b2
        case 5:
        case 6:
            if (Connection.schemaVersion > 4)
                ExecuteSQL('ALTER TABLE feeds ADD COLUMN markModifiedEntriesUnread INTEGER DEFAULT 1');
            // Fall through...

        // To 1.2b3
        case 7:
            this.migrateEntries();
            this.bookmarkStarredEntries();
            // Fall through...

        // To 1.2
        case 8:
            ExecuteSQL('DROP INDEX IF EXISTS entries_feedID_index');
            ExecuteSQL('CREATE INDEX IF NOT EXISTS entries_feedID_date_index ON entries (feedID, date) ');
            // Fall through...

        // To 1.5
        case 9:
            // Remove dead rows from entries_text.
            ExecuteSQL('DELETE FROM entries_text                       '+
                       'WHERE rowid IN (                               '+
                       '     SELECT entries_text.rowid                 '+
                       '     FROM entries_text LEFT JOIN entries       '+
                       '          ON entries_text.rowid = entries.id   '+
                       '     WHERE NOT EXISTS (                        '+
                       '         SELECT id                             '+
                       '         FROM entries                          '+
                       '         WHERE entries_text.rowid = entries.id '+
                       '     )                                         '+
                       ')                                              ');
        }

        Connection.schemaVersion = DATABASE_VERSION;
    },


    recreateFeedsTable: function Migration_recreateFeedsTable() {
        // Columns in this list must be in the same order as the respective columns
        // in the new schema.
        const OLD_COLS = 'feedID, feedURL, websiteURL, title, subtitle, imageURL,    '+
                         'imageLink, imageTitle, favicon, RDF_URI, rowIndex, parent, '+
                         'isFolder, hidden, lastUpdated, oldestAvailableEntryDate,   '+
                         'entryAgeLimit, maxEntries, updateInterval                  ';
        const NEW_COLS = 'feedID, feedURL, websiteURL, title, subtitle, imageURL,       '+
                         'imageLink, imageTitle, favicon, bookmarkID, rowIndex, parent, '+
                         'isFolder, hidden, lastUpdated, oldestEntryDate,               '+
                         'entryAgeLimit, maxEntries, updateInterval                     ';

        Connection.beginTransaction();
        try {
            ExecuteSQL('CREATE TABLE feeds_copy ('+OLD_COLS+')                               ');
            ExecuteSQL('INSERT INTO feeds_copy SELECT '+OLD_COLS+' FROM feeds                ');
            ExecuteSQL('DROP TABLE feeds                                                     ');
            ExecuteSQL('CREATE TABLE feeds ('+FEEDS_TABLE_SCHEMA+')                          ');
            ExecuteSQL('INSERT INTO feeds ('+NEW_COLS+') SELECT '+OLD_COLS+' FROM feeds_copy ');
            ExecuteSQL('DROP TABLE feeds_copy                                                ');
        }
        catch (ex) {
            ReportError(ex, true);
        }
        finally {
            Connection.commitTransaction();
        }
    },


    migrateEntries: function Migration_migrateEntries() {
        Connection.beginTransaction();
        try {
            let cols = 'id, feedID, secondaryID, providedID, entryURL, date, authors, '+
                       'read, updated, starred, deleted, bookmarkID, title, content   ';

            ExecuteSQL('CREATE TABLE entries_copy ('+cols+')                  ');
            ExecuteSQL('INSERT INTO entries_copy SELECT '+cols+' FROM entries ');
            ExecuteSQL('DROP TABLE entries                                    ');

            Storage.setupDatabase();

            let fromCols = 'feedID, providedID, entryURL, date, read, updated,       '+
                           'starred, deleted, bookmarkID, id, secondaryID            ';
            let toCols =   'feedID, providedID, entryURL, date, read, updated,       '+
                           'starred, deleted, bookmarkID, primaryHash, secondaryHash ';

            ExecuteSQL('INSERT INTO entries ('+toCols+')                                '+
                       'SELECT '+fromCols+' FROM entries_copy ORDER BY rowid            ');
            ExecuteSQL('INSERT INTO entries_text (title, content, authors)              '+
                       'SELECT title, content, authors FROM entries_copy ORDER BY rowid ');
            ExecuteSQL('DROP TABLE entries_copy                                         ');
        }
        catch (ex) {
            ReportError(ex, true);
        }
        finally {
            Connection.commitTransaction();
        }

        ExecuteSQL('VACUUM');
    },

    bookmarkStarredEntries: function Migration_bookmarkStarredEntries() {
        var folder = Bookmarks.unfiledBookmarksFolder;

        var sql = 'SELECT entries.entryURL, entries.id, entries_text.title                 '+
                  'FROM entries INNER JOIN entries_text ON entries.id = entries_text.rowid '+
                  'WHERE starred = 1                                                       ';
        var select = CreateStatement(sql);

        sql = 'UPDATE entries SET starred = 1, bookmarkID = :bookmarkID WHERE id = :entryID';
        var update = CreateStatement(sql);

        Connection.beginTransaction();
        try {
            while (select.step()) {
                let uri = Utils.newURI(select.row.entryURL);
                if (!uri)
                    continue;

                let title = select.row.title;
                let alreadyBookmarked = false;

                // Look for existing bookmarks for entry's URI.
                if (Bookmarks.isBookmarked(uri)) {
                    let bookmarkIDs = Bookmarks.getBookmarkIdsForURI(uri, {});
                    for each (let bookmarkID in bookmarkIDs) {
                        let parent = Bookmarks.getFolderIdForItem(bookmarkID);
                        if (!Utils.isLivemark(parent)) {
                            alreadyBookmarked = true;
                            break;
                        }
                    }
                }

                if (alreadyBookmarked) {
                    Storage.starEntry(true, select.row.id, bookmarkID);
                }
                else {
                    let bookmarkID = Bookmarks.insertBookmark(folder, uri, Bookmarks.DEFAULT_INDEX,
                                                              title);
                    update.params.entryID = select.row.id;
                    update.params.bookmarkID = bookmarkID;
                    update.execute();
                }
            }
        }
        catch (ex) {
            ReportError(ex);
        }
        finally {
            select.reset();
            Connection.commitTransaction();
        }
    },


    recomputeIDs: function Migration_recomputeIDs() {
        var hashStringFunc = {
            QueryInterface: XPCOMUtils.generateQI([Ci.mozIStorageFunction]),
            onFunctionCall: function(aArgs) Utils.hashString(aArgs.getUTF8String(0))
        }
        var generateEntryHashFunc = {
            QueryInterface: XPCOMUtils.generateQI([Ci.mozIStorageFunction]),
            onFunctionCall: function(aArgs) Utils.hashString(aArgs.getUTF8String(0) +
                                                             aArgs.getUTF8String(1))
        }

        Connection.createFunction('hashString', 1, hashStringFunc);
        Connection.createFunction('generateEntryHash', 2, generateEntryHashFunc);

        Connection.beginTransaction();
        try {
            ExecuteSQL('UPDATE OR IGNORE entries                                          ' +
                       'SET id = generateEntryHash(feedID, providedID)                    ' +
                       'WHERE rowid IN (                                                  ' +
                       '   SELECT entries.rowid                                           ' +
                       '   FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID ' +
                       '   WHERE entries.date >= feeds.oldestAvailableEntryDate AND       ' +
                       '         entries.providedID != ""                                 ' +
                       ')                                                                 ');
            ExecuteSQL('UPDATE OR IGNORE feeds SET feedID = hashString(feedURL) WHERE isFolder = 0');
        }
        catch (ex) {
            ReportError(ex, true);
        }
        finally {
            Connection.commitTransaction();
        }
    }

}


var BookmarkObserver = {

    livemarksSyncPending: false,
    batching: false,
    homeFolderContentModified: false,

    // nsINavBookmarkObserver
    onEndUpdateBatch: function BookmarkObserver_onEndUpdateBatch() {
        this.batching = false;
        if (this.homeFolderContentModified)
            this.delayedLivemarksSync();
        this.homeFolderContentModified = false;
    },

    // nsINavBookmarkObserver
    onBeginUpdateBatch: function BookmarkObserver_onBeginUpdateBatch() {
        this.batching = true;
    },

    // nsINavBookmarkObserver
    onItemAdded: function BookmarkObserver_onItemAdded(aItemID, aFolder, aIndex, aItemType) {
        if (aItemType == Bookmarks.TYPE_FOLDER && Utils.isInHomeFolder(aFolder)) {
            this.delayedLivemarksSync();
            return;
        }

        // Only care about plain bookmarks and tags.
        if (Utils.isLivemark(aFolder) || aItemType != Bookmarks.TYPE_BOOKMARK)
            return;

        // Find entries with the same URI as the added item and tag or star them.
        // Typically, there is going to be at most one such entry, so don't even
        // bother with a transaction.
        var url = Bookmarks.getBookmarkURI(aItemID).spec;
        var isTag = Utils.isTagFolder(aFolder);

        for each (let entry in Utils.getEntriesByURL(url)) {
            if (isTag) {
                // XXX Don't allow duplicate tags.
                let tagName = Bookmarks.getItemTitle(aFolder);
                Storage.tagEntry(true, entry.id, tagName, aItemID);
            }
            else {
                Storage.starEntry(true, entry.id, aItemID);
            }
        }
    },


    // nsINavBookmarkObserver
    onBeforeItemRemoved: function BookmarkObserver_onBeforeItemRemoved(aItemID, aItemType) {},

    // nsINavBookmarkObserver
    onItemRemoved: function BookmarkObserver_onItemRemoved(aItemID, aFolder, aIndex, aItemType) {
        if (Utils.isLivemarkStored(aItemID) || aItemID == Storage.homeFolderID) {
            this.delayedLivemarksSync();
            return;
        }

        // Only care about plain bookmarks and tags.
        if (Utils.isLivemark(aFolder) || aItemType != Bookmarks.TYPE_BOOKMARK)
            return;

        // Find entries with bookmarkID of the removed item and untag/unstar them.
        // Typically, there is going to be at most one such entry, so don't even
        // bother with a transaction.
        var isTag = Utils.isTagFolder(aFolder);

        if (isTag) {
            for each (let entry in Utils.getEntriesByTagID(aItemID)) {
                let tagName = Bookmarks.getItemTitle(aFolder);
                Storage.tagEntry(false, entry.id, tagName);
            }
        }
        else {
            let entries = Utils.getEntriesByBookmarkID(aItemID);

            // Look for other bookmarks for this URI.
            if (entries.length) {
                let uri = Utils.newURI(entries[0].url);
                var bookmarks = Bookmarks.getBookmarkIdsForURI(uri, {}).
                                          filter(Utils.isNormalBookmark);
            }

            for each (let entry in entries) {
                // If there is another bookmark for this URI, don't unstar the
                // entry, but update its bookmarkID to point to that bookmark.
                if (bookmarks.length)
                    Storage.starEntry(true, entry.id, bookmarks[0], true);
                else
                    Storage.starEntry(false, entry.id);
            }
        }
    },

    // nsINavBookmarkObserver
    onItemMoved: function BookmarkObserver_onItemMoved(aItemID, aOldParent, aOldIndex,
                                                   aNewParent, aNewIndex, aItemType) {
        var wasInHome = Utils.isLivemarkStored(aItemID);
        var isInHome = aItemType == Bookmarks.TYPE_FOLDER && Utils.isInHomeFolder(aNewParent);
        if (wasInHome || isInHome)
            this.delayedLivemarksSync();
    },

    // nsINavBookmarkObserver
    onItemChanged: function BookmarkObserver_onItemChanged(aItemID, aProperty,
                                                           aIsAnnotationProperty, aNewValue,
                                                           aLastModified, aItemType) {
        switch (aProperty) {
        case 'title':
            let feed = Utils.getFeedByBookmarkID(aItemID);
            if (feed) {
                Stm.setFeedTitle.execute({ 'title': aNewValue, 'feedID': feed.feedID });
                feed.title = aNewValue; // Update the cache.

                ObserverService.notifyObservers(null, 'brief:feed-title-changed', feed.feedID);
            }
            else if (Utils.isTagFolder(aItemID)) {
                this.renameTag(aItemID, aNewValue);
            }
            break;

        case 'livemark/feedURI':
            if (Utils.isLivemarkStored(aItemID))
                this.delayedLivemarksSync();
            break;

        case 'uri':
            // Unstar any entries with the old URI.
            for each (let entry in Utils.getEntriesByBookmarkID(aItemID))
                Storage.starEntry(false, entry.id);

            // Star any entries with the new URI.
            for each (let entry in Utils.getEntriesByURL(aNewValue))
                Storage.starEntry(true, entry.id, aItemID);

            break;
        }
    },

    // nsINavBookmarkObserver
    onItemVisited: function BookmarkObserver_aOnItemVisited(aItemID, aVisitID, aTime) { },

    get syncDelayTimer BookmarkObserver_syncDelayTimer() {
        if (!this.__syncDelayTimer)
            this.__syncDelayTimer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
        return this.__syncDelayTimer;
    },

    delayedLivemarksSync: function BookmarkObserver_delayedLivemarksSync() {
        if (this.batching) {
            this.homeFolderContentModified = true;
        }
        else {
            if (this.livemarksSyncPending)
                this.syncDelayTimer.cancel();

            this.syncDelayTimer.init(this, LIVEMARKS_SYNC_DELAY, Ci.nsITimer.TYPE_ONE_SHOT);
            this.livemarksSyncPending = true;
        }
    },

    /**
     * Syncs tags when a tag folder is renamed by removing tags with the old name
     * and re-tagging the entries using the new one.
     *
     * @param aTagFolderID itemId of the tag folder that was renamed.
     * @param aNewName     New name of the tag folder, i.e. new name of the tag.
     */
    renameTag: function BookmarkObserver_renameTag(aTagFolderID, aNewName) {
        // Get bookmarks in the renamed tag folder.
        var options = Places.history.getNewQueryOptions();
        var query = Places.history.getNewQuery();
        query.setFolders([aTagFolderID], 1);
        var result = Places.history.executeQuery(query, options);
        result.root.containerOpen = true;

        var oldTagName = '';

        for (let i = 0; i < result.root.childCount; i++) {
            let tagID = result.root.getChild(i).itemId;
            let entries = Utils.getEntriesByTagID(tagID).
                                map(function(e) e.id);

            for each (let entry in entries) {
                if (!oldTagName) {
                    // The bookmark observer doesn't provide the old name,
                    // so we have to look it up in the database.
                    let row = Stm.getNameForTagID.getSingleResult({ 'tagID': tagID });
                    oldTagName = row.tagName;
                }

                Storage.tagEntry(false, entry, oldTagName);
                Storage.tagEntry(true, entry, aNewName, tagID);
            }
        }

        result.root.containerOpen = false;
    },

    observe: function BookmarkObserver_observe(aSubject, aTopic, aData) {
        if (aTopic == 'timer-callback') {
            this.livemarksSyncPending = false;
            Storage.syncWithLivemarks();
        }
    },

    QueryInterface: XPCOMUtils.generateQI([Ci.nsINavBookmarkObserver, Ci.nsIObserver])

}


/**
 * Synchronizes the list of feeds stored in the database with
 * the livemarks available in the Brief's home folder.
 */
function LivemarksSync() {
    if (!this.checkHomeFolder())
        return;

    this.newLivemarks = [];

    Connection.beginTransaction();
    try {
        // Get the list of livemarks and folders in the home folder.
        this.getLivemarks();

        // Get the list of feeds stored in the database.
        this.getStoredFeeds();

        for each (let livemark in this.foundLivemarks) {
            let feed = null;
            for (let i = 0; i < this.storedFeeds.length; i++) {
                if (this.storedFeeds[i].feedID == livemark.feedID) {
                    feed = this.storedFeeds[i];
                    break;
                }
            }

            if (feed) {
                feed.bookmarked = true;
                this.updateFeedFromLivemark(livemark, feed);
            }
            else {
                this.insertFeed(livemark);
                if (!livemark.isFolder)
                    this.newLivemarks.push(livemark);
            }
        }

        for each (let feed in this.storedFeeds) {
            if (!feed.bookmarked && feed.hidden == 0)
                this.hideFeed(feed);
        }
    }
    finally {
        Connection.commitTransaction();
    }

    if (this.feedListChanged) {
        Storage.feedsCache = Storage.feedsAndFoldersCache = null;
        ObserverService.notifyObservers(null, 'brief:invalidate-feedlist', '');
    }

    // Update the newly added feeds.
    if (this.newLivemarks.length) {
        var feeds = [];
        for each (let livemark in this.newLivemarks)
            feeds.push(Storage.getFeed(livemark.feedID));

        FeedUpdateService.updateFeeds(feeds);
    }
}

LivemarksSync.prototype = {

    storedFeeds: null,
    newLivemarks: null,
    foundLivemarks: null,
    feedListChanged: false,

    checkHomeFolder: function BookmarksSync_checkHomeFolder() {
        var folderValid = true;
        var homeFolder = Prefs.getIntPref('homeFolder');

        if (homeFolder == -1) {
            let hideAllFeeds = new Statement('UPDATE feeds SET hidden = :hidden');
            hideAllFeeds.execute({ 'hidden': Date.now() });

            Storage.feedsCache = Storage.feedsAndFoldersCache = null;
            ObserverService.notifyObservers(null, 'brief:invalidate-feedlist', '');
            folderValid = false;
        }
        else {
            try {
                // This will throw if the home folder was deleted.
                Bookmarks.getItemTitle(homeFolder);
            }
            catch (e) {
                Prefs.clearUserPref('homeFolder');
                folderValid = false;
            }
        }

        return folderValid;
    },


    // Get the list of Live Bookmarks in the user's home folder.
    getLivemarks: function BookmarksSync_getLivemarks() {
        var homeFolder = Prefs.getIntPref('homeFolder');
        this.foundLivemarks = [];

        var options = Places.history.getNewQueryOptions();
        var query = Places.history.getNewQuery();
        query.setFolders([homeFolder], 1);
        options.excludeItems = true;

        var result = Places.history.executeQuery(query, options);
        this.traversePlacesQueryResults(result.root);
    },


    // Gets all feeds stored in the database.
    getStoredFeeds: function BookmarksSync_getStoredFeeds() {
        var sql = 'SELECT feedID, title, rowIndex, isFolder, parent, bookmarkID, hidden FROM feeds';

        this.storedFeeds = [];
        var results = new Statement(sql).getResults();
        for (let row = results.next(); row; row = results.next())
            this.storedFeeds.push(row);
        results.close();
    },


    insertFeed: function BookmarksSync_insertFeed(aBookmark) {
        var sql = 'INSERT OR IGNORE INTO feeds                                                   ' +
                  '(feedID, feedURL, title, rowIndex, isFolder, parent, bookmarkID)              ' +
                  'VALUES (:feedID, :feedURL, :title, :rowIndex, :isFolder, :parent, :bookmarkID)';

        new Statement(sql).execute({
            'feedID': aBookmark.feedID,
            'feedURL': aBookmark.feedURL || null,
            'title': aBookmark.title,
            'rowIndex': aBookmark.rowIndex,
            'isFolder': aBookmark.isFolder ? 1 : 0,
            'parent': aBookmark.parent,
            'bookmarkID': aBookmark.bookmarkID
        });

        this.feedListChanged = true;
    },


    updateFeedFromLivemark: function BookmarksSync_updateFeedFromLivemark(aItem, aFeed) {
        var properties = ['rowIndex', 'parent', 'title', 'bookmarkID'];
        if (!aFeed.hidden && properties.every(function(p) aFeed[p] == aItem[p]))
            return;

        var sql = 'UPDATE feeds SET title = :title, rowIndex = :rowIndex, parent = :parent, ' +
                  '                 bookmarkID = :bookmarkID, hidden = 0                    ' +
                  'WHERE feedID = :feedID                                                   ';

        new Statement(sql).execute({
            'title': aItem.title,
            'rowIndex': aItem.rowIndex,
            'parent': aItem.parent,
            'bookmarkID': aItem.bookmarkID,
            'feedID': aItem.feedID
        });

        if (aItem.rowIndex != aFeed.rowIndex || aItem.parent != aFeed.parent || aFeed.hidden > 0) {
            this.feedListChanged = true;
        }
        else {
            // Invalidate feeds cache.
            Storage.feedsCache = Storage.feedsAndFoldersCache = null;
            ObserverService.notifyObservers(null, 'brief:feed-title-changed', aItem.feedID);
        }
    },


    hideFeed: function BookmarksSync_hideFeed(aFeed) {
        if (aFeed.isFolder) {
            let hideFolder = new Statement('DELETE FROM feeds WHERE feedID = :feedID');
            hideFolder.execute({ 'feedID': aFeed.feedID });
        }
        else {
            let hideFeed = new Statement('UPDATE feeds SET hidden = :hidden WHERE feedID = :feedID');
            hideFeed.execute({ 'hidden': Date.now(), 'feedID': aFeed.feedID });
        }

        this.feedListChanged = true;
    },


    traversePlacesQueryResults: function BookmarksSync_traversePlacesQueryResults(aContainer) {
        aContainer.containerOpen = true;

        for (var i = 0; i < aContainer.childCount; i++) {
            var node = aContainer.getChild(i);

            if (node.type != Ci.nsINavHistoryResultNode.RESULT_TYPE_FOLDER)
                continue;

            var item = {};
            item.title = Bookmarks.getItemTitle(node.itemId);
            item.bookmarkID = node.itemId;
            item.rowIndex = this.foundLivemarks.length;
            item.parent = aContainer.itemId.toFixed().toString();

            if (Utils.isLivemark(node.itemId)) {
                var feedURL = Places.livemarks.getFeedURI(node.itemId).spec;
                item.feedURL = feedURL;
                item.feedID = Utils.hashString(feedURL);
                item.isFolder = false;

                this.foundLivemarks.push(item);
            }
            else {
                item.feedURL = '';
                item.feedID = node.itemId.toFixed().toString();
                item.isFolder = true;

                this.foundLivemarks.push(item);

                if (node instanceof Ci.nsINavHistoryContainerResultNode)
                    this.traversePlacesQueryResults(node);
            }
        }

        aContainer.containerOpen = false;
    }

}


// Cached statements.
var Stm = {

    get getAllFeeds() {
        var sql = 'SELECT feedID, feedURL, websiteURL, title, subtitle, dateModified, ' +
                  '       favicon, lastUpdated, oldestEntryDate, rowIndex, parent,    ' +
                  '       isFolder, bookmarkID, entryAgeLimit, maxEntries,            ' +
                  '       updateInterval, markModifiedEntriesUnread                   ' +
                  'FROM feeds                                                         ' +
                  'WHERE hidden = 0                                                   ' +
                  'ORDER BY rowIndex ASC                                              ';
        delete this.getAllFeeds;
        return this.getAllFeeds = new Statement(sql);
    },

    get getAllTags() {
        var sql = 'SELECT DISTINCT entry_tags.tagName                                    '+
                  'FROM entry_tags INNER JOIN entries ON entry_tags.entryID = entries.id '+
                  'WHERE entries.deleted = :deletedState                                 '+
                  'ORDER BY entry_tags.tagName                                           ';
        delete this.getAllTags;
        return this.getAllTags = new Statement(sql, { 'deletedState': Storage.ENTRY_STATE_NORMAL });
    },

    get updateFeed() {
        var sql = 'UPDATE feeds                                                  ' +
                  'SET websiteURL = :websiteURL, subtitle = :subtitle,           ' +
                  '    imageURL = :imageURL, imageLink = :imageLink,             ' +
                  '    imageTitle = :imageTitle, favicon = :favicon,             ' +
                  '    lastUpdated = :lastUpdated, dateModified = :dateModified, ' +
                  '    oldestEntryDate = :oldestEntryDate                        ' +
                  'WHERE feedID = :feedID                                        ';
        delete this.updateFeed;
        return this.updateFeed = new Statement(sql);
    },

    get setFeedTitle() {
        var sql = 'UPDATE feeds SET title = :title WHERE feedID = :feedID';
        delete this.setFeedTitle;
        return this.setFeedTitle = new Statement(sql);
    },

    get setFeedOptions() {
        var sql = 'UPDATE feeds                                ' +
                  'SET entryAgeLimit  = :entryAgeLimit,        ' +
                  '    maxEntries     = :maxEntries,           ' +
                  '    updateInterval = :updateInterval,       ' +
                  '    markModifiedEntriesUnread = :markUnread ' +
                  'WHERE feedID = :feedID                      ';
        delete this.setFeedOptions;
        return this.setFeedOptions = new Statement(sql);
    },

    get insertEntry() {
        var sql = 'INSERT INTO entries (feedID, primaryHash, secondaryHash, providedID, entryURL, date) ' +
                  'VALUES (:feedID, :primaryHash, :secondaryHash, :providedID, :entryURL, :date)        ';
        delete this.insertEntry;
        return this.insertEntry = new Statement(sql);
    },

    get insertEntryText() {
        var sql = 'INSERT INTO entries_text (title, content, authors) ' +
                  'VALUES(:title, :content, :authors)   ';
        delete this.insertEntryText;
        return this.insertEntryText = new Statement(sql);
    },

    get updateEntry() {
        var sql = 'UPDATE entries SET date = :date, read = :read, updated = 1 '+
                  'WHERE id = :id                                             ';
        delete this.updateEntry;
        return this.updateEntry = new Statement(sql);
    },

    get updateEntryText() {
        var sql = 'UPDATE entries_text SET title = :title, content = :content, '+
                  'authors = :authors WHERE rowid = :id                        ';
        delete this.updateEntryText;
        return this.updateEntryText = new Statement(sql);
    },

    get getLastRowids() {
        var sql = 'SELECT rowid FROM entries ORDER BY rowid DESC LIMIT :count';
        delete this.getLastRowids;
        return this.getLastRowids = new Statement(sql);
    },

    get purgeDeletedEntriesText() {
        var sql = 'DELETE FROM entries_text                                                 '+
                  'WHERE rowid IN (                                                         '+
                  '   SELECT entries.id                                                     '+
                  '   FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID        '+
                  '   WHERE (entries.deleted = :deletedState AND feeds.oldestEntryDate > entries.date) '+
                  '         OR (:currentDate - feeds.hidden > :retentionTime AND feeds.hidden != 0)    '+
                  ')                                                                                   ';
        delete this.purgeDeletedEntriesText;
        return this.purgeDeletedEntriesText = new Statement(sql);
    },

    get purgeDeletedEntries() {
        var sql = 'DELETE FROM entries                                                      '+
                  'WHERE id IN (                                                            '+
                  '   SELECT entries.id                                                     '+
                  '   FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID        '+
                  '   WHERE (entries.deleted = :deletedState AND feeds.oldestEntryDate > entries.date) '+
                  '         OR (:currentDate - feeds.hidden > :retentionTime AND feeds.hidden != 0)    '+
                  ')                                                                                   ';
        delete this.purgeDeletedEntries;
        return this.purgeDeletedEntries = new Statement(sql);
    },

    get purgeDeletedFeeds() {
        var sql = 'DELETE FROM feeds                                      '+
                  'WHERE :currentDate - feeds.hidden > :retentionTime AND '+
                  '      feeds.hidden != 0                                ';
        delete this.purgeDeletedFeeds;
        return this.purgeDeletedFeeds = new Statement(sql);
    },

    get expireEntriesByAgeGlobal() {
        var sql = 'UPDATE entries SET deleted = :newState                            ' +
                  'WHERE id IN (                                                     ' +
                  '   SELECT entries.id                                              ' +
                  '   FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID ' +
                  '   WHERE entries.deleted = :oldState AND                          ' +
                  '         feeds.entryAgeLimit = 0 AND                              ' +
                  '         entries.starred = 0 AND                                  ' +
                  '         entries.date < :edgeDate                                 ' +
                  ')                                                                 ';
        delete expireEntriesByAgeGlobal;
        return expireEntriesByAgeGlobal = new Statement(sql);
    },

    get expireEntriesByAgePerFeed() {
        var sql = 'UPDATE entries SET deleted = :newState  ' +
                  'WHERE entries.deleted = :oldState AND   ' +
                  '      starred = 0 AND                   ' +
                  '      entries.date < :edgeDate AND      ' +
                  '      feedID = :feedID                  ';
        delete expireEntriesByAgePerFeed;
        return expireEntriesByAgePerFeed = new Statement(sql);
    },

    get expireEntriesByNumber() {
        var sql = 'UPDATE entries                    ' +
                  'SET deleted = :newState           ' +
                  'WHERE rowid IN (                  ' +
                  '    SELECT rowid                  ' +
                  '    FROM entries                  ' +
                  '    WHERE deleted = :oldState AND ' +
                  '          starred = 0 AND         ' +
                  '          feedID = :feedID        ' +
                  '    ORDER BY date ASC             ' +
                  '    LIMIT :limit                  ' +
                  ')                                 ';
        delete this.expireEntriesByNumber;
        return this.expireEntriesByNumber = new Statement(sql);
    },

    get getDeletedEntriesCount() {
        var sql = 'SELECT COUNT(1) AS entryCount FROM entries  ' +
                  'WHERE feedID = :feedID AND                  ' +
                  '      starred = 0 AND                       ' +
                  '      deleted = :deletedState               ';
        delete this.getDeletedEntriesCount;
        return this.getDeletedEntriesCount = new Statement(sql);
    },

    get getEntryByPrimaryHash() {
        var sql = 'SELECT id, date, read FROM entries WHERE primaryHash = :primaryHash';
        delete this.getEntryByPrimaryHash;
        return this.getEntryByPrimaryHash = new Statement(sql);
    },

    get getEntryBySecondaryHash() {
        var sql = 'SELECT id, date, read FROM entries WHERE secondaryHash = :secondaryHash';
        delete this.getEntryBySecondaryHash;
        return this.getEntryBySecondaryHash = new Statement(sql);
    },

    get selectEntriesByURL() {
        var sql = 'SELECT id, starred FROM entries WHERE entryURL = :url';
        delete this.selectEntriesByURL;
        return this.selectEntriesByURL = new Statement(sql);
    },

    get selectEntriesByBookmarkID() {
        var sql = 'SELECT id, starred, entryURL FROM entries WHERE bookmarkID = :bookmarkID';
        delete this.selectEntriesByBookmarkID;
        return this.selectEntriesByBookmarkID = new Statement(sql);
    },

    get selectEntriesByTagID() {
        var sql = 'SELECT id, entryURL FROM entries WHERE id IN (          '+
                  '    SELECT entryID FROM entry_tags WHERE tagID = :tagID '+
                  ')                                                       ';
        delete this.selectEntriesByTagID;
        return this.selectEntriesByTagID = new Statement(sql);
    },

    get starEntry() {
        var sql = 'UPDATE entries SET starred = 1, bookmarkID = :bookmarkID WHERE id = :entryID';
        delete this.starEntry;
        return this.starEntry = new Statement(sql);
    },

    get unstarEntry() {
        var sql = 'UPDATE entries SET starred = 0, bookmarkID = -1 WHERE id = :id';
        delete this.unstarEntry;
        return this.unstarEntry = new Statement(sql);
    },

    get tagEntry() {
        // |OR IGNORE| is necessary, because some beta users mistakingly ended
        // up with tagID column marked as UNIQUE.
        var sql = 'INSERT OR IGNORE INTO entry_tags (entryID, tagName, tagID) '+
                  'VALUES (:entryID, :tagName, :tagID)            ';
        delete this.tagEntry;
        return this.tagEntry = new Statement(sql);
    },

    get untagEntry() {
        var sql = 'DELETE FROM entry_tags WHERE entryID = :entryID AND tagName = :tagName';
        delete this.untagEntry;
        return this.untagEntry = new Statement(sql);
    },

    get getTagsForEntry() {
        var sql = 'SELECT tagName FROM entry_tags WHERE entryID = :entryID';
        delete this.getTagsForEntry;
        return this.getTagsForEntry = new Statement(sql);
    },

    get getNameForTagID() {
        var sql = 'SELECT tagName FROM entry_tags WHERE tagID = :tagID LIMIT 1';
        delete this.getNameForTagID;
        return this.getNameForTagID = new Statement(sql);
    },

    get setSerializedTagList() {
        var sql = 'UPDATE entries_text SET tags = :tags WHERE rowid = :entryID';
        delete this.setSerializedTagList;
        return this.setSerializedTagList = new Statement(sql);
    }

}


var Utils = {

    getTagsForEntry: function getTagsForEntry(aEntryID) {
        var tags = [];

        var results = Stm.getTagsForEntry.getResults({ 'entryID': aEntryID });
        for (let row = results.next(); row; row = results.next())
            tags.push(row.tagName);
        results.close();

        return tags;
    },

    getFeedByBookmarkID: function getFeedByBookmarkID(aBookmarkID) {
        var foundFeed = null;
        var feeds = Storage.getAllFeeds(true);
        for (let i = 0; i < feeds.length; i++) {
            if (feeds[i].bookmarkID == aBookmarkID) {
                foundFeed = feeds[i];
                break;
            }
        }
        return foundFeed;
    },

    isLivemarkStored: function isLivemarkStored(aItemID) {
        return !!Utils.getFeedByBookmarkID(aItemID);
    },

    getEntriesByURL: function getEntriesByURL(aURL) {
        var entries = [];

        var results = Stm.selectEntriesByURL.getResults({ 'url': aURL });
        for (let row = results.next(); row; row = results.next()) {
            entries.push({
                id: row.id,
                starred: row.starred
            });
        }
        results.close();

        return entries;
    },

    getEntriesByBookmarkID: function getEntriesByBookmarkID(aBookmarkID) {
        var entries = [];

        var results = Stm.selectEntriesByBookmarkID.getResults({ 'bookmarkID': aBookmarkID });
        for (let row = results.next(); row; row = results.next()) {
            entries.push({
                id: row.id,
                url: row.entryURL,
                starred: row.starred
            });
        }
        results.close();

        return entries;
    },

    getEntriesByTagID: function getEntriesByTagID(aTagID) {
        var entries = [];

        var results = Stm.selectEntriesByTagID.getResults({ 'tagID': aTagID });
        for (let row = results.next(); row; row = results.next()) {
            entries.push({
                id: row.id,
                url: row.entryURL
            });
        }
        results.close();

        return entries;
    },

    newURI: function(aSpec) {
        if (!this.ioService)
            this.ioService = Cc['@mozilla.org/network/io-service;1'].getService(Ci.nsIIOService);

        try {
            var uri = this.ioService.newURI(aSpec, null, null);
        }
        catch (ex) {
            uri = null;
        }
        return uri;
    },

    isBookmark: function(aItemID) {
        return (Bookmarks.getItemType(aItemID) === Bookmarks.TYPE_BOOKMARK);
    },

    isNormalBookmark: function(aItemID) {
        let parent = Bookmarks.getFolderIdForItem(aItemID);
        return !Utils.isLivemark(parent) && !Utils.isTagFolder(parent);
    },

    isLivemark: function(aItemID) {
        return Places.livemarks.isLivemark(aItemID);
    },

    isFolder: function(aItemID) {
        return (Bookmarks.getItemType(aItemID) === Bookmarks.TYPE_FOLDER);
    },

    isTagFolder: function(aItemID) {
        return (Bookmarks.getFolderIdForItem(aItemID) === Places.tagsFolderId);
    },

    // Returns TRUE if an item is a subfolder of Brief's home folder.
    isInHomeFolder: function(aItemID) {
        var homeID = Storage.homeFolderID;
        if (homeID === -1)
            return false;

        if (homeID === aItemID)
            return true;

        var inHome = false;
        var parent = aItemID;
        while (parent !== Places.placesRootId) {
            parent = Bookmarks.getFolderIdForItem(parent);
            if (parent === homeID) {
                inHome = true;
                break;
            }
        }

        return inHome;
    },

    hashString: function(aString) {
        // nsICryptoHash can read the data either from an array or a stream.
        // Creating a stream ought to be faster than converting a long string
        // into an array using JS.
        var unicodeConverter = Cc['@mozilla.org/intl/scriptableunicodeconverter'].
                               createInstance(Ci.nsIScriptableUnicodeConverter);
        unicodeConverter.charset = 'UTF-8';
        var stream = unicodeConverter.convertToInputStream(aString);

        var hasher = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
        hasher.init(Ci.nsICryptoHash.MD5);
        hasher.updateFromStream(stream, stream.available());
        var hash = hasher.finish(false);

        // Convert the hash to a hex-encoded string.
        var hexchars = '0123456789ABCDEF';
        var hexrep = new Array(hash.length * 2);
        for (var i = 0; i < hash.length; ++i) {
            hexrep[i * 2] = hexchars.charAt((hash.charCodeAt(i) >> 4) & 15);
            hexrep[i * 2 + 1] = hexchars.charAt(hash.charCodeAt(i) & 15);
        }
        return hexrep.join('');
    }

}


function ReportError(aException, aRethrow) {
    var message = typeof aException == 'string' ? aException : aException.message;
    message += '\nStack: ' + aException.stack;
    message += '\nDatabase error: ' + Connection.lastErrorString;
    var error = new Error(message, aException.fileName, aException.lineNumber);
    if (aRethrow)
        throw(error);
    else
        Components.utils.reportError(error);
}


function log(aMessage) {
  var consoleService = Cc['@mozilla.org/consoleservice;1'].
                       getService(Ci.nsIConsoleService);
  consoleService.logStringMessage('Brief:\n' + aMessage);
}

Storage.init();