/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2019 Center for History and New Media
					George Mason University, Fairfax, Virginia, USA
					http://zotero.org
	
	This file is part of Zotero.
	
	Zotero is free software: you can redistribute it and/or modify
	it under the terms of the GNU Affero General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
	
	Zotero is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
	GNU Affero General Public License for more details.

	You should have received a copy of the GNU Affero General Public License
	along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
	
	***** END LICENSE BLOCK *****
*/

(function() {

const additionalCSLProperties = ['locator', 'label', 'suppress-author', 'author-only', 'prefix', 'suffix'];

/**
 * Bridging code which allows to use citeproc-js and citeproc-rs almost interchangeably
 * without big alterations to existing Zotero code
 */
Zotero.CiteprocRs = {
	init: async function () {
		if (Zotero.CiteprocRs.deferred) {
			return Zotero.CiteprocRs.deferred.promise;
		}
		Zotero.CiteprocRs.deferred = Zotero.Promise.defer();
		Zotero.debug("require('citeproc_rs_wasm')");
		// This is kind of nasty:
		// Due to Zotero being based on an old Firefox platform we are unable to use
		// the commonJS modules generated by citeproc_rs because they use too
		// advanced features.
		// Cormac has decided to provide a custom build just for Zotero
		// where citeproc_rs_wasm_include.js attaches some classes to Zotero.CiteprocRs.
		// This works fine until we call resetDB() in the test runner (or any other time we
		// could call ZoteroContext.reinit(). A usual require() call returns exported symbols
		// from some Gecko script cache. Unfortunately that means that the necessary citeproc
		// classes do not get reattached to the Zotero object and the Citeproc Wasm driver breaks
		// when trying to create its own objects (e.g. Zotero.CiteprocRs.WasmResult).
		// If we try to load citeproc_rs_wasm_include as a subscript we get errors about
		// let WasmResult; lines, i.e. a redeclaration of a symbol.
		// So we have to load this script and provide it a custom context with just a
		// Zotero symbol so that things don't break. Obviously this isn't optimal.
		// This might break with an upgrade to a higher Firefox version, but perhaps then we'll
		// be able to load the normal citeproc-rs CommonJS build.
		Components.classes["@mozilla.org/moz/jssubscript-loader;1"]
			.getService(Components.interfaces.mozIJSSubScriptLoader)
			.loadSubScript('resource://zotero/citeproc_rs_wasm_include.js',
				{ Zotero });
		// require('citeproc_rs_wasm_include');
		const CiteprocRs = require('citeproc_rs_wasm');
		// Initialize the wasm code
		Zotero.debug("Loading citeproc-rs wasm binary");
		const xhr = await Zotero.HTTP.request('GET', 'resource://zotero/citeproc_rs_wasm_bg.wasm', {
			responseType: "arraybuffer"
		});
		Zotero.debug("Initializing the CiteprocRs wasm driver");
		await CiteprocRs(xhr.response);
		Zotero.debug("CiteprocRs driver initialized successfully");
		this.Driver = CiteprocRs.Driver;
		Zotero.CiteprocRs.deferred.resolve();
	},
	
	Engine: class {
		constructor(system, style, styleXML, locale, format, overrideLocale=false) {
			this._styleXML = styleXML;
			this._overrideLocale = overrideLocale;
			
			this.locale = locale;

			this._format = format;
			this._resetDriver();

			this.styleID = style.styleID;
			this.hasBibliography = style._hasBibliography;
			this.sys = system;
			this.opt = { sort_citations: true };
		}
		
		free(ignoreErrors=false) {
			try {
				Zotero.debug('CiteprocRs: free Driver', 5);
				this._driver.free();
			}
			catch (e) {
				if (ignoreErrors) return;
				throw e;
			}
		}
		
		_resetDriver() {
			if (this._driver) {
				Zotero.debug('CiteprocRs: free Driver', 5);
				this._driver.free();
			}
			Zotero.debug('CiteprocRs: new Driver', 5);
			let options = {
				style: this._styleXML,
				format: this._format,
				fetcher: { fetchLocale: this._fetchLocale.bind(this) },
			}
			if (this._overrideLocale) {
				options.localeOverride = this.locale;
			}
			this._driver = new Zotero.CiteprocRs.Driver(options);
		}
		
		async _fetchLocale(lang) {
			return Zotero.Cite.System.prototype.retrieveLocale(lang);
		}
		
		setOutputFormat(format) {
			if (format == 'text') format = 'plain';
			if (this._format != format) {
				this._format = format;
				this._driver.setOutputFormat(format);
			}
		}
		
		_insertCitationReferences(citation) {
			let cites = [];
			for (const citationItem of citation.citationItems) {
				let citeprocItem = this.sys.retrieveItem(citationItem.id);
				citeprocItem.id = `${citeprocItem.id}`;
				Zotero.debug(`CiteprocRs: insertReference ${JSON.stringify(citeprocItem)}`, 5);
				this._driver.insertReference(citeprocItem);
				let cite = { id: `${citeprocItem.id}`, locator: undefined, locators: undefined };
				additionalCSLProperties.forEach((key) => {
					if (!citationItem[key]) return;
					switch (key) {
						case 'suppress-author':
							cite['mode'] = "SuppressAuthor";
							break;
						case 'author-only':
							cite['mode'] = "AuthorOnly";
							break;
						default:
							cite[key] = citationItem[key];
					}
				});
				cites.push(cite);
			}
			return cites;
		}

		_getClusterOrder(citations) {
			let clusters = [];
			for (let [citationID, noteIndex] of citations) {
				let cluster = { id: citationID };
				noteIndex = typeof noteIndex == "string" ? parseInt(noteIndex) : noteIndex;
				if (noteIndex) {
					cluster.note = noteIndex;
				}
				clusters.push(cluster);
			}
			return clusters;
		}

		previewCitationCluster(citation, citationsPre, citationsPost, outputFormat) {
			if (!citation.citationID) citation.citationID = Zotero.Utilities.randomString(10);
			
			let cites = this._insertCitationReferences(citation);
			let cluster = { cites };
			
			let thisClusterOrder = {};
			let noteIndex = citation.properties.noteIndex;
			noteIndex = typeof noteIndex == "string" ? parseInt(noteIndex) : noteIndex;
			if (noteIndex) {
				thisClusterOrder.note = noteIndex;
			}
			let allClusterOrder = this._getClusterOrder(citationsPre.concat(citationsPost));
			allClusterOrder.splice(citationsPre.length, 0, thisClusterOrder);
			
			Zotero.debug(`CiteprocRs: previewCluster ${JSON.stringify([cluster, allClusterOrder, outputFormat])}`, 5);
			return this._driver.previewCluster(cluster, allClusterOrder, outputFormat);
		}
		
		// This is an undocumented citeproc-js endpoint that is used by Zotero from way back
		// when generating citations for clipboard or export.
		appendCitationCluster(citation) {
			this.insertCluster(citation);
			Zotero.debug(`CiteprocRs: builtCluster ${citation.citationID}`, 5);
			return this._driver.builtCluster(citation.citationID);
		}
		
		insertCluster(citation) {
			let cluster = { id: citation.citationID };
			cluster.cites = this._insertCitationReferences(citation);

			Zotero.debug(`CiteprocRs: insertCluster ${JSON.stringify(cluster)}`, 5);
			this._driver.insertCluster(cluster);
			return cluster;
		}
	
		setClusterOrder(citations) {
			let clusters = this._getClusterOrder(citations);
			Zotero.debug(`CiteprocRs: setClusterOrder ${JSON.stringify(clusters)}`, 5);
			this._driver.setClusterOrder(clusters);
		}
		
		getBatchedUpdates() {
			Zotero.debug(`CiteprocRs: batchedUpdates`, 5);
			return this._driver.batchedUpdates();
		}
		
		rebuildProcessorState(citations, format, uncited) {
			this._format = format;
			this._resetDriver();
			for (let citation of citations) {
				this.insertCluster(citation);
			}
			this.setClusterOrder(citations.map(
				citation => [citation.citationID, citation.properties.noteIndex]));
			this.updateUncitedItems(uncited);
		}
		
		updateUncitedItems(itemIDs) {
			let referenceIDs = [];
			for (let id of itemIDs) {
				let citeprocItem = this.sys.retrieveItem(id);
				citeprocItem.id = `${citeprocItem.id}`;
				referenceIDs.push(citeprocItem.id);
				Zotero.debug(`CiteprocRs: insertReference ${JSON.stringify(citeprocItem)}`, 5);
				this._driver.insertReference(citeprocItem);
			}
			Zotero.debug(`CiteprocRs: includeUncitedItems ${JSON.stringify(referenceIDs)}`);
			this._driver.includeUncited({ Specific: referenceIDs });
		}
		
		updateItems(itemIDs) {
			Zotero.debug('CiteprocRstoJs: updateItems [forwarding to updateUncitedItems()]');
			return this.updateUncitedItems(itemIDs);
		}
		
		makeBibliography() {
			Zotero.debug(`CiteprocRs: bibliographyMeta`, 5);
			
			// Converting from the wrongly documented citeproc-rs return format
			// to the poorly named citeproc-js format. Sigh.
			let bibliographyMeta = this._driver.bibliographyMeta();
			bibliographyMeta = Object.assign(bibliographyMeta, {
				maxoffset: bibliographyMeta.maxOffset,
				linespacing: bibliographyMeta.lineSpacing,
				entryspacing: bibliographyMeta.entrySpacing,
				hangingindent: bibliographyMeta.hangingIndent,
				bibstart: bibliographyMeta.formatMeta && bibliographyMeta.formatMeta.markupPre,
				bibend: bibliographyMeta.formatMeta && bibliographyMeta.formatMeta.markupPost,
			});
			bibliographyMeta['second-field-align'] = bibliographyMeta.secondFieldAlign;
			
			Zotero.debug(`CiteprocRs: makeBibliography`, 5);
			const bibliographyEntries = this._driver.makeBibliography();
			// Crazy citeproc-js behavior here
			const entry_ids = bibliographyEntries.map(entry => [entry.id]);
			let strings;
			if (this._format == 'html') {
				strings = bibliographyEntries.map(entry => `<div class="csl-entry">${entry.value}</div>`);
			}
			else if (this._format == 'plain') {
				strings = bibliographyEntries.map(entry => `${entry.value}\n`);
			}
			else {
				strings = bibliographyEntries.map(entry => entry.value);
			}
			return [
				Object.assign({ entry_ids }, bibliographyMeta),
				strings
			];
		}
	},
};

})();
