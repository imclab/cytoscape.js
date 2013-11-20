/*
  The canvas renderer was written by Yue Dong.

  Modifications tracked on Github.
*/

(function($$) {

	function CanvasRenderer(options) {
		
		CanvasRenderer.CANVAS_LAYERS = 5;
		CanvasRenderer.SELECT_BOX = 0;
		CanvasRenderer.DRAG = 2;
		CanvasRenderer.OVERLAY = 3;
		CanvasRenderer.NODE = 4;
		CanvasRenderer.BUFFER_COUNT = 2;

		this.options = options;

		this.data = {
				
			select: [undefined, undefined, undefined, undefined, 0], // Coordinates for selection box, plus enabled flag 
			renderer: this, cy: options.cy, container: options.cy.container(),
			
			canvases: new Array(CanvasRenderer.CANVAS_LAYERS),
			canvasRedrawReason: new Array(CanvasRenderer.CANVAS_LAYERS),
			canvasNeedsRedraw: new Array(CanvasRenderer.CANVAS_LAYERS),
			
			bufferCanvases: new Array(CanvasRenderer.BUFFER_COUNT)

		};
		
		//--Pointer-related data
		this.hoverData = {down: null, last: null, 
				downTime: null, triggerMode: null, 
				dragging: false, 
				initialPan: [null, null], capture: false};
		
		this.timeoutData = {panTimeout: null};
		
		this.dragData = {possibleDragElements: []};
		
		this.touchData = {start: null, capture: false,
				// These 3 fields related to tap, taphold events
				startPosition: [null, null, null, null, null, null],
				singleTouchStartTime: null,
				singleTouchMoved: true,
				
				
				now: [null, null, null, null, null, null], 
				earlier: [null, null, null, null, null, null] };
		//--
		
		//--Wheel-related data 
		this.zoomData = {freeToZoom: false, lastPointerX: null};
		//--
		
		this.redraws = 0;

		this.bindings = [];
		
		this.init();
		
		for (var i = 0; i < CanvasRenderer.CANVAS_LAYERS; i++) {
			this.data.canvases[i] = document.createElement("canvas");
			this.data.canvases[i].style.position = "absolute";
			this.data.canvases[i].setAttribute("data-id", "layer" + i);
			this.data.canvases[i].style.zIndex = String(CanvasRenderer.CANVAS_LAYERS - i);
			this.data.container.appendChild(this.data.canvases[i]);
			
			this.data.canvasRedrawReason[i] = new Array();
			this.data.canvasNeedsRedraw[i] = false;
		}

		this.data.canvases[CanvasRenderer.NODE].setAttribute("data-id", "layer" + CanvasRenderer.NODE + '-node');
		this.data.canvases[CanvasRenderer.SELECT_BOX].setAttribute("data-id", "layer" + CanvasRenderer.SELECT_BOX + '-selectbox');
		this.data.canvases[CanvasRenderer.DRAG].setAttribute("data-id", "layer" + CanvasRenderer.DRAG + '-drag');
		this.data.canvases[CanvasRenderer.OVERLAY].setAttribute("data-id", "layer" + CanvasRenderer.OVERLAY + '-overlay');
		
		for (var i = 0; i < CanvasRenderer.BUFFER_COUNT; i++) {
			this.data.bufferCanvases[i] = document.createElement("canvas");
			this.data.bufferCanvases[i].style.position = "absolute";
			this.data.bufferCanvases[i].setAttribute("data-id", "buffer" + i);
			this.data.bufferCanvases[i].style.zIndex = String(-i - 1);
			this.data.bufferCanvases[i].style.visibility = "hidden";
			this.data.container.appendChild(this.data.bufferCanvases[i]);
		}

		var overlay = document.createElement('div');
		this.data.container.appendChild( overlay );
		this.data.overlay = overlay;
		overlay.style.position = 'absolute';
		overlay.style.zIndex = 1000;

		if( options.showOverlay ){

			var link = document.createElement('a');
			overlay.appendChild( link );
			this.data.link = link;

			link.innerHTML = 'cytoscape.js';
			link.style.font = '14px helvetica';
			link.style.position = 'absolute';
			link.style.right = 0;
			link.style.bottom = 0;
			link.style.padding = '1px 3px';
			link.style.paddingLeft = '5px';
			link.style.paddingTop = '5px';
			link.style.opacity = 0;
			link.style['-webkit-tap-highlight-color'] = 'transparent';
			link.style.background = 'red';

			link.href = 'http://cytoscape.github.io/cytoscape.js/';
			link.target = '_blank';

		}

		this.hideEdgesOnViewport = options.hideEdgesOnViewport;

		this.load();
	}

	CanvasRenderer.panOrBoxSelectDelay = 400;
	CanvasRenderer.isTouch = ('ontouchstart' in window) || window.DocumentTouch && document instanceof DocumentTouch;

	CanvasRenderer.prototype.notify = function(params) {
		if ( params.type == "destroy" ){
			this.destroy();
			return;

		} else if (params.type == "add"
			|| params.type == "remove"
			|| params.type == "load"
		) {
			
			this.updateNodesCache();
			this.updateEdgesCache();
		}

		if (params.type == "viewport") {
			this.data.canvasNeedsRedraw[CanvasRenderer.SELECT_BOX] = true;
			this.data.canvasRedrawReason[CanvasRenderer.SELECT_BOX].push("viewchange");
		}
		
		this.data.canvasNeedsRedraw[CanvasRenderer.DRAG] = true; this.data.canvasRedrawReason[CanvasRenderer.DRAG].push("notify");
		this.data.canvasNeedsRedraw[CanvasRenderer.NODE] = true; this.data.canvasRedrawReason[CanvasRenderer.NODE].push("notify");

		this.redraws++;
		this.redraw();
	};

	CanvasRenderer.prototype.registerBinding = function(target, event, handler, useCapture){
		this.bindings.push({
			target: target,
			event: event,
			handler: handler,
			useCapture: useCapture
		});

		target.addEventListener(event, handler, useCapture);
	};

	CanvasRenderer.prototype.destroy = function(){
		this.destroyed = true;

		for( var i = 0; i < this.bindings.length; i++ ){
			var binding = this.bindings[i];
			var b = binding;

			b.target.removeEventListener(b.event, b.handler, b.useCapture);
		}
	};
	
	

	// @O Initialization functions
	{
	CanvasRenderer.prototype.load = function() {
		var r = this;

		// helper function to determine which child nodes and inner edges
		// of a compound node to be dragged as well as the grabbed and selected nodes
		var addDescendantsToDrag = function(node, addSelected, dragElements) {
			if (!addSelected)
			{
				var parents = node.parents();

				// do not process descendants for this node,
				// because those will be handled for the topmost selected parent
				for (var i=0; i < parents.size(); i++)
				{
				    if (parents[i]._private.selected)
				    {
					    return;
				    }
				}
			}

			var innerNodes = node.descendants();

			function hasNonAutoParent(ele){
				while( ele.parent().nonempty() && ele.parent().id() !== node.id() ){
					parent = ele.parent()[0];
					var pstyle = parent._private.style;

					if( pstyle.width.value !== 'auto' || pstyle.height.value !== 'auto' ){
						return true;
					}

					ele = ele.parent();
				}

				return false;
			}

			// TODO do not drag hidden children & children of hidden children?
			for (var i=0; i < innerNodes.size(); i++)
			{
				// if addSelected is true, then add node in any case,
				// if not, then add only non-selected nodes
				if ( (addSelected || !innerNodes[i]._private.selected) )
				{
					innerNodes[i]._private.rscratch.inDragLayer = true;
					//innerNodes[i].trigger(new $$.Event(e, {type: "grab"}));
					//innerNodes[i].trigger(event);
					dragElements.push(innerNodes[i]);

					for (var j=0; j < innerNodes[i]._private.edges.length; j++)
					{
						innerNodes[i]._private.edges[j]._private.rscratch.inDragLayer = true;
					}
				}
			}
		};

		// adds the given nodes, and its edges to the drag layer
		var addNodeToDrag = function(node, dragElements) {
			node._private.grabbed = true;
			node._private.rscratch.inDragLayer = true;

			dragElements.push(node);

			for (var i=0;i<node._private.edges.length;i++) {
				node._private.edges[i]._private.rscratch.inDragLayer = true;
			}

			//node.trigger(new $$.Event(e, {type: "grab"}));
		};

		// helper function to determine which ancestor nodes and edges should go
		// to the drag layer (or should be removed from drag layer).
		var updateAncestorsInDragLayer = function(node, inDragLayer) {
			// find top-level parent
			var parent = node;

			while (parent.parent().nonempty())
			{
				parent = parent.parent()[0];

				// var pstyle = parent._private.style;
				// if( pstyle.width.value !== 'auto' || pstyle.height.value !== 'auto' ){
				// 	parent = node;
				// 	break;
				// }
			}

			// no parent node: no node to add to the drag layer
			if (parent == node && inDragLayer)
			{
				return;
			}

			var nodes = parent.descendants().add(parent);

			for (var i=0; i < nodes.size(); i++)
			{

				nodes[i]._private.rscratch.inDragLayer = inDragLayer;

				// TODO when calling this function for a set of nodes, we visit same edges over and over again,
				// instead of adding edges for each node, it may be better to iterate all edges at once
				// or another solution is to find out the common ancestors and process only those nodes for edges
				for (var j=0; j<nodes[i]._private.edges.length; j++) {
					nodes[i]._private.edges[j]._private.rscratch.inDragLayer = inDragLayer;
				}
			}
		};

		CanvasRenderer.prototype.nodeIsDraggable = function(node) {
			if (node._private.style["opacity"].value != 0
				&& node._private.style["visibility"].value == "visible"
				&& node._private.style["display"].value == "element"
				&& !node._private.locked
				&& node._private.grabbable) {
	
				return true;
			}
			
			return false;
		}

		// auto resize
		r.registerBinding(window, "resize", function(e) { 
			r.data.canvasNeedsRedraw[CanvasRenderer.NODE] = true;
			r.data.canvasNeedsRedraw[CanvasRenderer.OVERLAY] = true;
			r.matchCanvasSize( r.data.container );
			r.redraw();
		}, true);

		// stop right click menu from appearing on cy
		r.registerBinding(r.data.container, "contextmenu", function(e){
			e.preventDefault();
		});

		// Primary key
		r.registerBinding(r.data.container, "mousedown", function(e) { 
			e.preventDefault();
			r.hoverData.capture = true;
			r.hoverData.which = e.which;
			
			var cy = r.data.cy; var pos = r.projectIntoViewport(e.pageX, e.pageY);
			var select = r.data.select;
			var near = r.findNearestElement(pos[0], pos[1], true);
			var down = r.hoverData.down;
			var draggedElements = r.dragData.possibleDragElements;
			var grabEvent = new $$.Event(e, {type: "grab"});

			// Right click button
			if( e.which == 3 ){

				if( near ){
					near.activate();
					near.trigger( new $$.Event(e, {type: "cxttapstart"}) );

					r.hoverData.down = near;
					r.hoverData.downTime = (new Date()).getTime();
					r.hoverData.cxtDragged = false;
				}

			// Primary button
			} else if (e.which == 1) {
				
				if( near ){
					near.activate();
				}

				// Element dragging
				{
					// If something is under the cursor and it is draggable, prepare to grab it
					if (near != null && r.nodeIsDraggable(near)) {
						if (near._private.group == "nodes" && near._private.selected == false) {

							draggedElements = r.dragData.possibleDragElements = [ ];
							addNodeToDrag(near, draggedElements);
							near.trigger(grabEvent);

							// add descendant nodes only if the compound size is set to auto
							if (near._private.style["width"].value == "auto" ||
							    near._private.style["height"].value == "auto")
							{
								addDescendantsToDrag(near,
									true,
									draggedElements);
							}

							// also add nodes and edges related to the topmost ancestor
							updateAncestorsInDragLayer(near, true);
						}
								
						if (near._private.group == "nodes" && near._private.selected == true) {
							draggedElements = r.dragData.possibleDragElements = [  ];

							var triggeredGrab = false;
							var selectedNodes = cy.$('node:selected');
							for( var i = 0; i < selectedNodes.length; i++ ){
								//r.dragData.possibleDragElements.push( selectedNodes[i] );
								
								// Only add this selected node to drag if it is draggable, eg. has nonzero opacity
								if (r.nodeIsDraggable(selectedNodes[i]))
								{
									addNodeToDrag(selectedNodes[i], draggedElements);
									
									// only trigger for grabbed node once
									if( !triggeredGrab ){
										near.trigger(grabEvent);
										triggeredGrab = true;
									}

									if (selectedNodes[i]._private.style["width"].value == "auto" ||
										selectedNodes[i]._private.style["height"].value == "auto")
									{
										addDescendantsToDrag(selectedNodes[i],
											false,
											draggedElements);
									}

									// also add nodes and edges related to the topmost ancestor
									updateAncestorsInDragLayer(selectedNodes[i], true);
								}
							}
						}
						
						near
							.trigger(new $$.Event(e, {type: "mousedown"}))
							.trigger(new $$.Event(e, {type: "tapstart"}))
							.trigger(new $$.Event(e, {type: "vmousedown"}))
						;
						
						// r.data.canvasNeedsRedraw[CanvasRenderer.DRAG] = true; r.data.canvasRedrawReason[CanvasRenderer.DRAG].push("Single node moved to drag layer"); 
						// r.data.canvasNeedsRedraw[CanvasRenderer.NODE] = true; r.data.canvasRedrawReason[CanvasRenderer.NODE].push("Single node moved to drag layer");
						
					} else if (near == null) {
						cy
							.trigger(new $$.Event(e, {type: "mousedown"}))
							.trigger(new $$.Event(e, {type: "tapstart"}))
							.trigger(new $$.Event(e, {type: "vmousedown"}))
						;
					}
					
					r.hoverData.down = near;
					r.hoverData.downTime = (new Date()).getTime();

				}
			
				// Selection box
				if ( near == null || near.isEdge() ) {
					select[4] = 1;
					var timeUntilActive = Math.max( 0, CanvasRenderer.panOrBoxSelectDelay - (+new Date - r.hoverData.downTime) );

					clearTimeout( r.bgActiveTimeout );
					r.bgActiveTimeout = setTimeout(function(){
						if( near ){
							near.unactivate();
						}

						r.data.bgActivePosistion = {
							x: pos[0],
							y: pos[1]
						};

						r.data.canvasNeedsRedraw[CanvasRenderer.SELECT_BOX] = true;
						r.data.canvasRedrawReason[CanvasRenderer.SELECT_BOX].push("bgactive");

						r.redraw();
					}, timeUntilActive);
					
				}
			
			} 
			
			// Initialize selection box coordinates
			select[0] = select[2] = pos[0];
			select[1] = select[3] = pos[1];
			
			r.redraw();
			
		}, false);
		
		r.registerBinding(window, "mousemove", function(e) {
			var preventDefault = false;
			var capture = r.hoverData.capture;

			if (!capture) {
				
				var containerPageCoords = r.findContainerPageCoords();
				
				if (e.pageX > containerPageCoords[0] && e.pageX < containerPageCoords[0] + r.data.container.clientWidth
					&& e.pageY > containerPageCoords[1] && e.pageY < containerPageCoords[1] + r.data.container.clientHeight) {
					
				} else {
					return;
				}
			}

			var cy = r.data.cy;
			var pos = r.projectIntoViewport(e.pageX, e.pageY);
			var select = r.data.select;
			
			var near = r.findNearestElement(pos[0], pos[1], true);
			var last = r.hoverData.last;
			var down = r.hoverData.down;
			
			var disp = [pos[0] - select[2], pos[1] - select[3]];
			var nodes = r.getCachedNodes();
			var edges = r.getCachedEdges();
		
			var draggedElements = r.dragData.possibleDragElements;
		

			var shiftDown = e.shiftKey;
			

			preventDefault = true;

			// Mousemove event
			{
				var event = new $$.Event(e, {type: "mousemove"});
				
				if (near != null) {
					near.trigger(event);
					
				} else if (near == null) {
					cy.trigger(event);
				}

			}
			
			
			// trigger context drag if rmouse down
			if( r.hoverData.which === 3 ){
				var cxtEvt = new $$.Event(e, {type: "cxtdrag"});

				if( down ){
					down.trigger( cxtEvt );
				} else {
					cy.trigger( cxtEvt );
				}

				r.hoverData.cxtDragged = true;

			// Check if we are drag panning the entire graph
			} else if (r.hoverData.dragging) {
				preventDefault = true;

				if( cy.panningEnabled() ){
					var deltaP = {x: disp[0] * cy.zoom(), y: disp[1] * cy.zoom()};

					cy.panBy( deltaP );
				}
				
				// Needs reproject due to pan changing viewport
				pos = r.projectIntoViewport(e.pageX, e.pageY);

			// Checks primary button down & out of time & mouse not moved much
			} else if (select[4] == 1 && (down == null || down.isEdge())
					&& ( !cy.boxSelectionEnabled() || +new Date - r.hoverData.downTime >= CanvasRenderer.panOrBoxSelectDelay )
					&& (Math.abs(select[3] - select[1]) + Math.abs(select[2] - select[0]) < 4)
					&& cy.panningEnabled() ) {
				
				r.hoverData.dragging = true;
				select[4] = 0;

			} else {
				// deactivate bg on box selection
				if (cy.boxSelectionEnabled() && Math.pow(select[2] - select[0], 2) + Math.pow(select[3] - select[1], 2) > 7 && select[4]){
					clearTimeout( r.bgActiveTimeout );
				}
				
				if( down && down.isEdge() && down.active() ){ down.unactivate(); }

				if (near != last) {
					
					if (last) { last.trigger(new $$.Event(e, {type: "mouseout"})); }
					if (near) { near.trigger(new $$.Event(e, {type: "mouseover"})); }
					
					r.hoverData.last = near;
				}
				
				if ( down && down.isNode() && r.nodeIsDraggable(down) ) {
					r.dragData.didDrag = true; // indicate that we actually did drag the node

					var toTrigger = [];
					for (var i=0; i<draggedElements.length; i++) {

						// Locked nodes not draggable, as well as non-visible nodes
						if (draggedElements[i]._private.group == "nodes"
							&& r.nodeIsDraggable(draggedElements[i])) {
							
							draggedElements[i]._private.position.x += disp[0];
							draggedElements[i]._private.position.y += disp[1];

							toTrigger.push( draggedElements[i] );
						}
					}
					
					(new $$.Collection(cy, toTrigger))
						.trigger( new $$.Event(e, {type: "drag"}) )
						.trigger( new $$.Event(e, {type: "position"}) )
					;

					if (select[2] == select[0] && select[3] == select[1]) {
						r.data.canvasNeedsRedraw[CanvasRenderer.NODE] = true;
						r.data.canvasRedrawReason[CanvasRenderer.NODE].push("Node(s) and edge(s) moved to drag layer");
					}
					
					r.data.canvasNeedsRedraw[CanvasRenderer.DRAG] = true;
					r.data.canvasRedrawReason[CanvasRenderer.DRAG].push("Nodes dragged");
				}
				
				if( cy.boxSelectionEnabled() ){
					r.data.canvasNeedsRedraw[CanvasRenderer.SELECT_BOX] = true;
					r.data.canvasRedrawReason[CanvasRenderer.SELECT_BOX].push("Mouse moved, redraw selection box");
				}

				// prevent the dragging from triggering text selection on the page
				preventDefault = true;
			}
			
			select[2] = pos[0]; select[3] = pos[1];
			
			r.redraw();
			
			if( preventDefault ){ 
				if(e.stopPropagation) e.stopPropagation();
    			if(e.preventDefault) e.preventDefault();
   				e.cancelBubble=true;
    			e.returnValue=false;
    			return false;
    		}
		}, false);
		
		r.registerBinding(window, "mouseup", function(e) {
			// console.log('--\nmouseup', e)

			var capture = r.hoverData.capture; if (!capture) { return; }; r.hoverData.capture = false;
		
			var cy = r.data.cy; var pos = r.projectIntoViewport(e.pageX, e.pageY); var select = r.data.select;
			var near = r.findNearestElement(pos[0], pos[1], true);
			var nodes = r.getCachedNodes(); var edges = r.getCachedEdges(); 
			var draggedElements = r.dragData.possibleDragElements; var down = r.hoverData.down;
			var shiftDown = e.shiftKey;
			
			r.data.bgActivePosistion = undefined; // not active bg now
			clearTimeout( r.bgActiveTimeout );

			if( down ){
				down.unactivate();
			}

			if( r.hoverData.which === 3 ){
				var cxtEvt = new $$.Event(e, {type: "cxttapend"});

				if( down ){
					down.trigger( cxtEvt );
				} else {
					cy.trigger( cxtEvt );
				}

				if( !r.hoverData.cxtDragged ){
					var cxtTap = new $$.Event(e, {type: "cxttap"});

					if( down ){
						down.trigger( cxtTap );
					} else {
						cy.trigger( cxtTap );
					}
				}

				r.hoverData.cxtDragged = false;
				r.hoverData.which = null;

			// if not right mouse
			} else {

				// Deselect all elements if nothing is currently under the mouse cursor and we aren't dragging something
				if ( (down == null) // not mousedown on node
					&& !r.dragData.didDrag // didn't move the node around
					&& !(Math.pow(select[2] - select[0], 2) + Math.pow(select[3] - select[1], 2) > 7 && select[4]) // not box selection
					&& !r.hoverData.dragging // not panning
				) {

					// console.log('unselect all from bg');

	//++clock+unselect
	//				var a = time();
					cy.$(':selected').unselect();
					
	//++clock+unselect
	//				console.log("unselect", time() - a);
					
					if (draggedElements.length > 0) {
						r.data.canvasNeedsRedraw[CanvasRenderer.NODE] = true; r.data.canvasRedrawReason[CanvasRenderer.NODE].push("De-select");
					}
					
					r.dragData.possibleDragElements = draggedElements = [];
				}
				
				// Click event
				{
					// console.log('trigger click et al');

					if (Math.pow(select[2] - select[0], 2) + Math.pow(select[3] - select[1], 2) == 0) {
						if (near != null) {
							near
								.trigger( new $$.Event(e, {type: "click"}) )
								.trigger( new $$.Event(e, {type: "tap"}) )
								.trigger( new $$.Event(e, {type: "vclick"}) )
							;
						} else if (near == null) {
							cy
								.trigger( new $$.Event(e, {type: "click"}) )
								.trigger( new $$.Event(e, {type: "tap"}) )
								.trigger( new $$.Event(e, {type: "vclick"}) )
							;
						}
					}
				}
				
				// Mouseup event
				{
					// console.log('trigger mouseup et al');

					if (near != null) {
						near
							.trigger(new $$.Event(e, {type: "mouseup"}))
							.trigger(new $$.Event(e, {type: "tapend"}))
							.trigger(new $$.Event(e, {type: "vmouseup"}))
						;
					} else if (near == null) {
						cy
							.trigger(new $$.Event(e, {type: "mouseup"}))
							.trigger(new $$.Event(e, {type: "tapend"}))
							.trigger(new $$.Event(e, {type: "vmouseup"}))
						;
					}
				}
				
				// Single selection
				if (near == down && !r.dragData.didDrag) {
					if (near != null && near._private.selectable) {
						
						// console.log('single selection')

						if( cy.selectionType() === 'additive' ){
							if( near.selected() ){
							near.unselect();
							} else {
								near.select();
							}
						} else {
							if( !shiftDown ){
								cy.$(':selected').unselect();
							}

							near.select();
						}


						updateAncestorsInDragLayer(near, false);
						
						r.data.canvasNeedsRedraw[CanvasRenderer.NODE] = true; r.data.canvasRedrawReason[CanvasRenderer.NODE].push("sglslct");
						
					}
				// Ungrab single drag
				} else if (near == down) {
					if (near != null && near._private.grabbed) {
						// console.log('ungrab single drag')

						var grabbedEles = cy.$(':grabbed');

						for(var i = 0; i < grabbedEles.length; i++){
							var ele = grabbedEles[i];

							ele._private.grabbed = false;
							
							var sEdges = ele._private.edges;
							for (var j=0;j<sEdges.length;j++) { sEdges[j]._private.rscratch.inDragLayer = false; }

							// for compound nodes, also remove related nodes and edges from the drag layer
							updateAncestorsInDragLayer(ele, false);
						}

						var freeEvent = new $$.Event(e, {type: "free"});
						grabbedEles.trigger(freeEvent);
					}
				}
				
				if ( cy.boxSelectionEnabled() &&  Math.pow(select[2] - select[0], 2) + Math.pow(select[3] - select[1], 2) > 7 && select[4] ) {
					// console.log("box selection");
					
					var newlySelected = [];
					var box = r.getAllInBox(select[0], select[1], select[2], select[3]);
					// console.log(box);
					var event = new $$.Event(e, {type: "select"});
					for (var i=0;i<box.length;i++) { 
						if (box[i]._private.selectable) {
							draggedElements.push( box[i] ); 
							newlySelected.push( box[i] );
						}
					}

					var newlySelCol = new $$.Collection( cy, newlySelected );

					if( cy.selectionType() === "additive" ){
						newlySelCol.select();
					} else {
						if( !shiftDown ){
							cy.$(':selected').unselect();
						}

						newlySelCol.select();
					}
					
					if (box.length > 0) { 
						r.data.canvasNeedsRedraw[CanvasRenderer.NODE] = true; r.data.canvasRedrawReason[CanvasRenderer.NODE].push("Selection");
					}
				}
				
				// Cancel drag pan
				r.hoverData.dragging = false;
				
				if (!select[4]) {
					// console.log('free at end', draggedElements)
					var freeEvent = new $$.Event(e, {type: "free"}); 
					
					for (var i=0;i<draggedElements.length;i++) {
						
						if (draggedElements[i]._private.group == "nodes") { 
							draggedElements[i]._private.rscratch.inDragLayer = false;
						  
							var sEdges = draggedElements[i]._private.edges;
							for (var j=0;j<sEdges.length;j++) { sEdges[j]._private.rscratch.inDragLayer = false; }

							// for compound nodes, also remove related nodes and edges from the drag layer
							updateAncestorsInDragLayer(draggedElements[i], false);
							
						} else if (draggedElements[i]._private.group == "edges") {
							draggedElements[i]._private.rscratch.inDragLayer = false;
						}
						
					}

					if( down){ down.trigger(freeEvent); }

	//				draggedElements = r.dragData.possibleDragElements = [];
					r.data.canvasNeedsRedraw[CanvasRenderer.DRAG] = true; r.data.canvasRedrawReason[CanvasRenderer.DRAG].push("Node/nodes back from drag");
					r.data.canvasNeedsRedraw[CanvasRenderer.NODE] = true; r.data.canvasRedrawReason[CanvasRenderer.NODE].push("Node/nodes back from drag");
				}
			
			} // else not right mouse

			select[4] = 0; r.hoverData.down = null;
			
			r.data.canvasNeedsRedraw[CanvasRenderer.SELECT_BOX] = true; r.data.canvasRedrawReason[CanvasRenderer.SELECT_BOX].push("Mouse up, selection box gone");
			
//			console.log("mu", pos[0], pos[1]);
//			console.log("ss", select);
			
			r.dragData.didDrag = false;

			r.redraw();
			
		}, false);
		
		var wheelHandler = function(e) { 

			// console.dir(e) 
			// console.log( e.srcElement );
			// console.log( r.data.overlay );

			var cy = r.data.cy; var pos = r.projectIntoViewport(e.pageX, e.pageY);
			
			var unpos = [pos[0] * cy.zoom() + cy.pan().x,
			              pos[1] * cy.zoom() + cy.pan().y];
			
			// console.log( r.zoomData.freeToZoom );

			// TODO re-evaluate whether freeToZoom is necessary at all now
			if (true || r.zoomData.freeToZoom) {
				//console.log('free')
				e.preventDefault();
				
				var diff = e.wheelDeltaY / 1000 || e.wheelDelta / 1000 || e.detail / -32 || -e.deltaY / 500;

				//console.log(diff)
				
				if( cy.panningEnabled() && cy.zoomingEnabled() ){
					cy.zoom({level: cy.zoom() * Math.pow(10, diff), position: {x: unpos[0], y: unpos[1]}});
				}

				r.data.wheel = true;
				clearTimeout(r.data.wheelTimeout);
				r.data.wheelTimeout = setTimeout(function(){
					r.data.wheel = false;
					r.data.canvasNeedsRedraw[CanvasRenderer.NODE] = true;
					r.redraw();
				}, 100);
			}

		}
		
		// Functions to help with whether mouse wheel should trigger zooming
		// --
		r.registerBinding(r.data.container, "wheel", wheelHandler, true);

		r.registerBinding(r.data.container, "mousewheel", wheelHandler, true);
		
		r.registerBinding(r.data.container, "DOMMouseScroll", wheelHandler, true);

		r.registerBinding(r.data.container, "MozMousePixelScroll", function(e){
			if (r.zoomData.freeToZoom) {
				e.preventDefault();
			}
		}, false);
		
		r.registerBinding(r.data.container, "mousemove", function(e) { 
			if (r.zoomData.lastPointerX && r.zoomData.lastPointerX != e.pageX && !r.zoomData.freeToZoom) 
				{ r.zoomData.freeToZoom = true; } r.zoomData.lastPointerX = e.pageX; 
		}, false);
		
		r.registerBinding(r.data.container, "mouseout", function(e) { 
			r.zoomData.freeToZoom = false; r.zoomData.lastPointerX = null 
		}, false);
		// --
		
		// Functions to help with handling mouseout/mouseover on the Cytoscape container
					// Handle mouseout on Cytoscape container
		r.registerBinding(r.data.container, "mouseout", function(e) { 
			r.data.cy.trigger(new $$.Event(e, {type: "mouseout"}));
		}, false);
		
		r.registerBinding(r.data.container, "mouseover", function(e) { 
			r.data.cy.trigger(new $$.Event(e, {type: "mouseover"}));
		}, false);
		
		var f1x1, f1y1, f2x1, f2y1; // starting points for pinch-to-zoom
		var distance1; // initial distance between finger 1 and finger 2 for pinch-to-zoom
		var center1, modelCenter1; // center point on start pinch to zoom
		var offsetLeft, offsetTop;
		var containerWidth = r.data.container.clientWidth, containerHeight = r.data.container.clientHeight;
		var twoFingersStartInside;

		function distance(x1, y1, x2, y2){
			return Math.sqrt( (x2-x1)*(x2-x1) + (y2-y1)*(y2-y1) );
		}

		r.registerBinding(r.data.container, "touchstart", function(e) {

			clearTimeout( this.threeFingerSelectTimeout );

			if( e.target !== r.data.link ){
				e.preventDefault();
			}
		
			r.touchData.capture = true;
			r.data.bgActivePosistion = undefined;

			var cy = r.data.cy; 
			var nodes = r.getCachedNodes(); var edges = r.getCachedEdges();
			var now = r.touchData.now; var earlier = r.touchData.earlier;
			
			if (e.touches[0]) { var pos = r.projectIntoViewport(e.touches[0].pageX, e.touches[0].pageY); now[0] = pos[0]; now[1] = pos[1]; }
			if (e.touches[1]) { var pos = r.projectIntoViewport(e.touches[1].pageX, e.touches[1].pageY); now[2] = pos[0]; now[3] = pos[1]; }
			if (e.touches[2]) { var pos = r.projectIntoViewport(e.touches[2].pageX, e.touches[2].pageY); now[4] = pos[0]; now[5] = pos[1]; }
			
			// record starting points for pinch-to-zoom
			if( e.touches[1] ){

				// anything in the set of dragged eles should be released
				function release( eles ){
					for( var i = 0; i < eles.length; i++ ){
						eles[i]._private.grabbed = false;
						eles[i]._private.rscratch.inDragLayer = false;
						if( eles[i].active() ){ eles[i].unactivate(); }
					}
				}
				release(nodes);
				release(edges);

				var offsets = r.findContainerPageCoords();
				offsetTop = offsets[1];
				offsetLeft = offsets[0];

				f1x1 = e.touches[0].pageX - offsetLeft;
				f1y1 = e.touches[0].pageY - offsetTop;
				
				f2x1 = e.touches[1].pageX - offsetLeft;
				f2y1 = e.touches[1].pageY - offsetTop;

				twoFingersStartInside = 
					   0 <= f1x1 && f1x1 <= containerWidth
					&& 0 <= f2x1 && f2x1 <= containerWidth
					&& 0 <= f1y1 && f1y1 <= containerHeight
					&& 0 <= f2y1 && f2y1 <= containerHeight
				;

				var pan = cy.pan();
				var zoom = cy.zoom();

				distance1 = distance( f1x1, f1y1, f2x1, f2y1 );
				center1 = [ (f1x1 + f2x1)/2, (f1y1 + f2y1)/2 ];
				modelCenter1 = [ 
					(center1[0] - pan.x) / zoom,
					(center1[1] - pan.y) / zoom
				];

				// consider context tap
				if( distance1 < 100 ){

					var near1 = r.findNearestElement(now[0], now[1], true);
					var near2 = r.findNearestElement(now[2], now[3], true);
					var cxtEvt = new $$.Event(e, {type: "cxttapstart"});

					//console.log(distance1)

					if( near1 && near1.isNode() ){
						near1.activate().trigger( cxtEvt );
						r.touchData.start = near1;
					
					} else if( near2 && near2.isNode() ){
						near2.activate().trigger( cxtEvt );
						r.touchData.start = near2;
					
					} else {
						cy.trigger( cxtEvt );
						r.touchData.start = null;
					} 

					if( r.touchData.start ){ r.touchData.start._private.grabbed = false; }
					r.touchData.cxt = true;
					r.touchData.cxtDragged = false;
					r.data.bgActivePosistion = undefined;

					//console.log('cxttapstart')

					r.redraw();
					return;
					
				}

				// console.log(center1);
				// console.log('touchstart ptz');
				// console.log(offsetLeft, offsetTop);
				// console.log(f1x1, f1y1);
				// console.log(f2x1, f2y1);
				// console.log(distance1);
				// console.log(center1);
			}

			// console.log('another tapstart')
			
			
			if (e.touches[2]) {
			
			} else if (e.touches[1]) {
				
			} else if (e.touches[0]) {
				var near = r.findNearestElement(now[0], now[1], true);

				if (near != null) {
					near.activate();

					r.touchData.start = near;
					
					if (near._private.group == "nodes" && r.nodeIsDraggable(near))
					{

						var draggedEles = r.dragData.touchDragEles = [];
						addNodeToDrag(near, draggedEles);
						near.trigger(new $$.Event(e, {type: "grab"}));

						if( near.selected() ){
							// reset drag elements, since near will be added again
							draggedEles = r.dragData.touchDragEles = [];

							var selectedNodes = cy.$('node:selected');

							for( var k = 0; k < selectedNodes.length; k++ ){

								var selectedNode = selectedNodes[k];
								if (r.nodeIsDraggable(selectedNode)) {
									draggedEles.push( selectedNode );
									selectedNode._private.rscratch.inDragLayer = true;

									var sEdges = selectedNode._private.edges;
									for (var j=0; j<sEdges.length; j++) {
									  sEdges[j]._private.rscratch.inDragLayer = true;
									}

									if (selectedNode._private.style["width"].value == "auto" ||
									    selectedNode._private.style["height"].value == "auto")
									{
										addDescendantsToDrag(selectedNode,
											false,
											draggedEles);
									}

									// also add nodes and edges related to the topmost ancestor
									updateAncestorsInDragLayer(selectedNode, true);
								}
							}
						} else {
							//draggedEles.push( near );

							// add descendant nodes only if the compound size is set to auto
							if (near._private.style["width"].value == "auto" ||
							    near._private.style["height"].value == "auto")
							{
								addDescendantsToDrag(near,
									true,
									draggedEles);
							}

							// also add nodes and edges related to the topmost ancestor
							updateAncestorsInDragLayer(near, true);
						}
					}
					
					near
						.trigger(new $$.Event(e, {type: "touchstart"}))
						.trigger(new $$.Event(e, {type: "tapstart"}))
						.trigger(new $$.Event(e, {type: "vmousdown"}))
					;
				} if (near == null) {
					cy
						.trigger(new $$.Event(e, {type: "touchstart"}))
						.trigger(new $$.Event(e, {type: "tapstart"}))
						.trigger(new $$.Event(e, {type: "vmousedown"}))
					;

					r.data.bgActivePosistion = {
						x: pos[0],
						y: pos[1]
					};

					r.data.canvasNeedsRedraw[CanvasRenderer.SELECT_BOX] = true;
					r.data.canvasRedrawReason[CanvasRenderer.SELECT_BOX].push("bgactive");

				}
				
				
				// Tap, taphold
				// -----
				
				for (var i=0;i<now.length;i++) {
					earlier[i] = now[i];
					r.touchData.startPosition[i] = now[i];
				};
				
				r.touchData.singleTouchMoved = false;
				r.touchData.singleTouchStartTime = +new Date;
				
				var tapHoldTimeout = setTimeout(function() {
					if (r.touchData.singleTouchMoved == false
							// This time double constraint prevents multiple quick taps
							// followed by a taphold triggering multiple taphold events
							&& (+new Date) - r.touchData.singleTouchStartTime > 250) {
						if (r.touchData.start) {
							r.touchData.start.trigger(new $$.Event(e, {type: "taphold"}));
						} else {
							r.data.cy.trigger(new $$.Event(e, {type: "taphold"}));

							cy.$(':selected').unselect();
						}

//						console.log("taphold");
					}
				}, 1000);
			}
			
			r.redraw();
			
		}, false);
		
// console.log = function(m){ $('#console').append('<div>'+m+'</div>'); };

		r.registerBinding(window, "touchmove", function(e) {
		
			var select = r.data.select;
			var capture = r.touchData.capture; //if (!capture) { return; }; 
			capture && e.preventDefault();
		
			var cy = r.data.cy; 
			var nodes = r.getCachedNodes(); var edges = r.getCachedEdges();
			var now = r.touchData.now; var earlier = r.touchData.earlier;
			
			if (e.touches[0]) { var pos = r.projectIntoViewport(e.touches[0].pageX, e.touches[0].pageY); now[0] = pos[0]; now[1] = pos[1]; }
			if (e.touches[1]) { var pos = r.projectIntoViewport(e.touches[1].pageX, e.touches[1].pageY); now[2] = pos[0]; now[3] = pos[1]; }
			if (e.touches[2]) { var pos = r.projectIntoViewport(e.touches[2].pageX, e.touches[2].pageY); now[4] = pos[0]; now[5] = pos[1]; }
			var disp = []; for (var j=0;j<now.length;j++) { disp[j] = now[j] - earlier[j]; }
			

			if( capture && r.touchData.cxt ){
				var f1x2 = e.touches[0].pageX - offsetLeft, f1y2 = e.touches[0].pageY - offsetTop;
				var f2x2 = e.touches[1].pageX - offsetLeft, f2y2 = e.touches[1].pageY - offsetTop;
				var distance2 = distance( f1x2, f1y2, f2x2, f2y2 );
				var factor = distance2 / distance1;

				//console.log(factor, distance2)

				// cancel ctx gestures if the distance b/t the fingers increases
				if( factor >= 1.5 || distance2 >= 150 ){
					r.touchData.cxt = false;
					if( r.touchData.start ){ r.touchData.start.unactivate(); r.touchData.start = null; }
					r.data.bgActivePosistion = undefined;
					r.data.canvasNeedsRedraw[CanvasRenderer.SELECT_BOX] = true;

					var cxtEvt = new $$.Event(e, {type: "cxttapend"});
					if( r.touchData.start ){
						r.touchData.start.trigger( cxtEvt );
					} else {
						cy.trigger( cxtEvt );
					}
				}

			}  

			if( capture && r.touchData.cxt ){
				var cxtEvt = new $$.Event(e, {type: "cxtdrag"});
				r.data.bgActivePosistion = undefined;
				r.data.canvasNeedsRedraw[CanvasRenderer.SELECT_BOX] = true;

				if( r.touchData.start ){
					r.touchData.start.trigger( cxtEvt );
				} else {
					cy.trigger( cxtEvt );
				}

				if( r.touchData.start ){ r.touchData.start._private.grabbed = false; }
				r.touchData.cxtDragged = true;

				//console.log('cxtdrag')

			} else if( capture && e.touches[2] && cy.boxSelectionEnabled() ){
				r.data.bgActivePosistion = undefined;
				clearTimeout( this.threeFingerSelectTimeout );
				this.lastThreeTouch = +new Date;

				r.data.canvasNeedsRedraw[CanvasRenderer.SELECT_BOX] = true;
				r.data.canvasRedrawReason[CanvasRenderer.SELECT_BOX].push("Touch moved, redraw selection box");

				if( !select || select.length === 0 || select[0] === undefined ){
					select[0] = (now[0] + now[2] + now[4])/3;
					select[1] = (now[1] + now[3] + now[5])/3;
					select[2] = (now[0] + now[2] + now[4])/3 + 1;
					select[3] = (now[1] + now[3] + now[5])/3 + 1;
				} else {
					select[2] = (now[0] + now[2] + now[4])/3;
					select[3] = (now[1] + now[3] + now[5])/3;
				}

				select[4] = 1;

			} else if ( capture && e.touches[1] && cy.zoomingEnabled() && cy.panningEnabled() ) { // two fingers => pinch to zoom
				r.data.bgActivePosistion = undefined;
				r.data.canvasNeedsRedraw[CanvasRenderer.SELECT_BOX] = true;

				// console.log('touchmove ptz');

				// (x2, y2) for fingers 1 and 2
				var f1x2 = e.touches[0].pageX - offsetLeft, f1y2 = e.touches[0].pageY - offsetTop;
				var f2x2 = e.touches[1].pageX - offsetLeft, f2y2 = e.touches[1].pageY - offsetTop;

				// console.log( f1x2, f1y2 )
				// console.log( f2x2, f2y2 )

				var distance2 = distance( f1x2, f1y2, f2x2, f2y2 );
				var factor = distance2 / distance1;

				// console.log(distance2)
				// console.log(factor)

				if( factor != 1 && twoFingersStartInside){

					// console.log(factor)
					// console.log(distance2 + ' / ' + distance1);
					// console.log('--');

					// delta finger1
					var df1x = f1x2 - f1x1;
					var df1y = f1y2 - f1y1;

					// delta finger 2
					var df2x = f2x2 - f2x1;
					var df2y = f2y2 - f2y1;

					// translation is the normalised vector of the two fingers movement
					// i.e. so pinching cancels out and moving together pans
					var tx = (df1x + df2x)/2;
					var ty = (df1y + df2y)/2;

					// adjust factor by the speed multiplier
					// var speed = 1.5;
					// if( factor > 1 ){
					// 	factor = (factor - 1) * speed + 1;
					// } else {
					// 	factor = 1 - (1 - factor) * speed;
					// }

					// now calculate the zoom
					var zoom1 = cy.zoom();
					var zoom2 = zoom1 * factor;
					var pan1 = cy.pan();

					// the model center point converted to the current rendered pos
					var ctrx = modelCenter1[0] * zoom1 + pan1.x;
					var ctry = modelCenter1[1] * zoom1 + pan1.y;

					var pan2 = {
						x: -zoom2/zoom1 * (ctrx - pan1.x - tx) + ctrx,
						y: -zoom2/zoom1 * (ctry - pan1.y - ty) + ctry
					};

					// console.log(pan2);
					// console.log(zoom2);

					cy._private.zoom = zoom2;
					cy._private.pan = pan2;
					cy
						.trigger('pan zoom')
						.notify('viewport')
					;

					distance1 = distance2;	
					f1x1 = f1x2;
					f1y1 = f1y2;
					f2x1 = f2x2;
					f2y1 = f2y2;

					r.pinching = true;
				}
				
				// Re-project
				if (e.touches[0]) { var pos = r.projectIntoViewport(e.touches[0].pageX, e.touches[0].pageY); now[0] = pos[0]; now[1] = pos[1]; }
				if (e.touches[1]) { var pos = r.projectIntoViewport(e.touches[1].pageX, e.touches[1].pageY); now[2] = pos[0]; now[3] = pos[1]; }
				if (e.touches[2]) { var pos = r.projectIntoViewport(e.touches[2].pageX, e.touches[2].pageY); now[4] = pos[0]; now[5] = pos[1]; }

			} else if (e.touches[0]) {
				var start = r.touchData.start;
				var last = r.touchData.last;
				
				if ( start != null && start._private.group == "nodes" && r.nodeIsDraggable(start)) {
					var draggedEles = r.dragData.touchDragEles;

					for( var k = 0; k < draggedEles.length; k++ ){
						var draggedEle = draggedEles[k];

						if( r.nodeIsDraggable(draggedEle) ){
							r.dragData.didDrag = true;

							draggedEle._private.position.x += disp[0];
							draggedEle._private.position.y += disp[1];
			
						}
					}

					( new $$.Collection(cy, draggedEles) )
						.trigger( new $$.Event(e, {type: "drag"}) )
						.trigger( new $$.Event(e, {type: "position"}) )
					;
					
					r.data.canvasNeedsRedraw[CanvasRenderer.DRAG] = true;
					r.data.canvasRedrawReason[CanvasRenderer.DRAG].push("touchdrag node");

					if (r.touchData.startPosition[0] == earlier[0]
						&& r.touchData.startPosition[1] == earlier[1]) {
						
						r.data.canvasNeedsRedraw[CanvasRenderer.NODE] = true;
						r.data.canvasRedrawReason[CanvasRenderer.NODE].push("node drag started");
					}
					
				}
				
				// Touchmove event
				{
					if (start != null) { start.trigger(new $$.Event(e, {type: "touchmove"})); }
					
					if (start == null) { 
						var near = r.findNearestElement(now[0], now[1], true);
						if (near != null) { near.trigger(new $$.Event(e, {type: "touchmove"})); }
						if (near == null) {   cy.trigger(new $$.Event(e, {type: "touchmove"})); }
					}

					if (near != last) {
						if (last) { last.trigger(new $$.Event(e, {type: "touchout"})); }
						if (near) { near.trigger(new $$.Event(e, {type: "touchover"})); }
					}

					r.touchData.last = near;
				}
				
				// Check to cancel taphold
				for (var i=0;i<now.length;i++) {
					if (now[i] 
						&& r.touchData.startPosition[i]
						&& Math.abs(now[i] - r.touchData.startPosition[i]) > 4) {
						
						r.touchData.singleTouchMoved = true;
					}
				}
				
				if ( capture && (start == null || start.isEdge()) && cy.panningEnabled() ) {
					if( start ){
						start.unactivate();

						if( !r.data.bgActivePosistion ){
							r.data.bgActivePosistion = {
								x: now[0],
								y: now[1]
							};
						}

						r.data.canvasNeedsRedraw[CanvasRenderer.SELECT_BOX] = true;
						r.data.canvasRedrawReason[CanvasRenderer.SELECT_BOX].push("bgactive");
					}

					cy.panBy({x: disp[0] * cy.zoom(), y: disp[1] * cy.zoom()});
					r.swipePanning = true;
					
					// Re-project
					var pos = r.projectIntoViewport(e.touches[0].pageX, e.touches[0].pageY);
					now[0] = pos[0]; now[1] = pos[1];
				}
			}

			for (var j=0;j<now.length;j++) { earlier[j] = now[j]; };
			r.redraw();
			
		}, false);
		
		r.registerBinding(window, "touchend", function(e) {
			
			var capture = r.touchData.capture; if (!capture) { return; }; r.touchData.capture = false;
			e.preventDefault();
			var select = r.data.select;

			r.swipePanning = false;
			
			var cy = r.data.cy; 
			var nodes = r.getCachedNodes(); var edges = r.getCachedEdges();
			var now = r.touchData.now; var earlier = r.touchData.earlier;
			var start = r.touchData.start;

			if (e.touches[0]) { var pos = r.projectIntoViewport(e.touches[0].pageX, e.touches[0].pageY); now[0] = pos[0]; now[1] = pos[1]; }
			if (e.touches[1]) { var pos = r.projectIntoViewport(e.touches[1].pageX, e.touches[1].pageY); now[2] = pos[0]; now[3] = pos[1]; }
			if (e.touches[2]) { var pos = r.projectIntoViewport(e.touches[2].pageX, e.touches[2].pageY); now[4] = pos[0]; now[5] = pos[1]; }
			
			if( r.touchData.cxt ){
				ctxTapend = new $$.Event(e, { type: 'cxttapend' });

				if( start ){
					start.unactivate();
					start.trigger( ctxTapend );
				} else {
					cy.trigger( ctxTapend );
				}

				//console.log('cxttapend')

				if( !r.touchData.cxtDragged ){
					var ctxTap = new $$.Event(e, { type: 'cxttap' });

					if( start ){
						start.trigger( ctxTap );
					} else {
						cy.trigger( ctxTap );
					}

					//console.log('cxttap')
				}

				if( r.touchData.start ){ r.touchData.start._private.grabbed = false; }
				r.touchData.cxt = false;
				r.touchData.start = null;

				r.redraw();
				return;
			}

			var nowTime = +new Date;
			// no more box selection if we don't have three fingers
			if( !e.touches[2] && cy.boxSelectionEnabled() ){
				clearTimeout( this.threeFingerSelectTimeout );
				//this.threeFingerSelectTimeout = setTimeout(function(){
					var newlySelected = [];
					var box = r.getAllInBox(select[0], select[1], select[2], select[3]);

					select[0] = undefined;
					select[1] = undefined;
					select[2] = undefined;
					select[3] = undefined;
					select[4] = 0;

					r.data.canvasNeedsRedraw[CanvasRenderer.SELECT_BOX] = true;
					r.data.canvasRedrawReason[CanvasRenderer.SELECT_BOX].push("Touch moved, redraw selection box");

					// console.log(box);
					var event = new $$.Event(e, {type: "select"});
					for (var i=0;i<box.length;i++) { 
						if (box[i]._private.selectable) {
							newlySelected.push( box[i] );
						}
					}

					var newlySelCol = (new $$.Collection( cy, newlySelected ));

					if( cy.selectionType() === 'single' ){
						cy.$(':selected').unselect();
					}

					newlySelCol.select();
					
					if (box.length > 0) { 
						r.data.canvasNeedsRedraw[CanvasRenderer.NODE] = true; r.data.canvasRedrawReason[CanvasRenderer.NODE].push("Selection");
					}

				//}, 100);
			}

			if( !e.touches[1] ){
				r.pinching = false;
			}

			var updateStartStyle = false;

			if( start != null ){
				start._private.active = false;
				updateStartStyle = true;
				start.trigger( new $$.Event(e, {type: "unactivate"}) );
			}

			if (e.touches[2]) {
				r.data.bgActivePosistion = undefined;
			} else if (e.touches[1]) {
				
			} else if (e.touches[0]) {
			
			// Last touch released
			} else if (!e.touches[0]) {
				
				r.data.bgActivePosistion = undefined;

				if (start != null ) {

					if (start._private.grabbed == true) {
						start._private.grabbed = false;
						start.trigger(new $$.Event(e, {type: "free"}));
						start._private.rscratch.inDragLayer = false;
					}
					
					var sEdges = start._private.edges;
					for (var j=0;j<sEdges.length;j++) { sEdges[j]._private.rscratch.inDragLayer = false; }
					updateAncestorsInDragLayer(start, false);
					
					if( start.selected() ){
						var selectedNodes = cy.$('node:selected');

						for( var k = 0; k < selectedNodes.length; k++ ){

							var selectedNode = selectedNodes[k];
							selectedNode._private.rscratch.inDragLayer = false;

							var sEdges = selectedNode._private.edges;
							for (var j=0; j<sEdges.length; j++) {
							  sEdges[j]._private.rscratch.inDragLayer = false;
							}

							updateAncestorsInDragLayer(selectedNode, false);
						}
					}

					r.data.canvasNeedsRedraw[CanvasRenderer.DRAG] = true; r.data.canvasRedrawReason[CanvasRenderer.DRAG].push("touchdrag node end");
					r.data.canvasNeedsRedraw[CanvasRenderer.NODE] = true; r.data.canvasRedrawReason[CanvasRenderer.NODE].push("touchdrag node end");
					
					start
						.trigger(new $$.Event(e, {type: "touchend"}))
						.trigger(new $$.Event(e, {type: "tapend"}))
						.trigger(new $$.Event(e, {type: "vmouseup"}))
					;
					
					r.touchData.start = null;
					
				} else {
					var near = r.findNearestElement(now[0], now[1], true);
				
					if (near != null) { 
						near
							.trigger(new $$.Event(e, {type: "touchend"}))
							.trigger(new $$.Event(e, {type: "tapend"}))
							.trigger(new $$.Event(e, {type: "vmouseup"}))
						;
					}

					if (near == null) { 
						cy
							.trigger(new $$.Event(e, {type: "touchend"}))
							.trigger(new $$.Event(e, {type: "tapend"}))
							.trigger(new $$.Event(e, {type: "vmouseup"}))
						;
					}
				}
				
				// Prepare to select the currently touched node, only if it hasn't been dragged past a certain distance
				if (start != null 
						&& !r.dragData.didDrag // didn't drag nodes around
						&& start._private.selectable 
						&& (Math.sqrt(Math.pow(r.touchData.startPosition[0] - now[0], 2) + Math.pow(r.touchData.startPosition[1] - now[1], 2))) < 6) {

					if( cy.selectionType() === "single" ){
						cy.$(':selected').unselect();
						start.select();
					} else {
						if( start.selected() ){
							start.unselect();
						} else {
							start.select();
						}
					}

					updateStartStyle = true;

					
					r.data.canvasNeedsRedraw[CanvasRenderer.NODE] = true; r.data.canvasRedrawReason[CanvasRenderer.NODE].push("sglslct");
				}
				
				// Tap event, roughly same as mouse click event for touch
				if (r.touchData.singleTouchMoved == false) {

					if (start) {
						start
							.trigger(new $$.Event(e, {type: "tap"}))
							.trigger(new $$.Event(e, {type: "vclick"}))
						;
					} else {
						cy
							.trigger(new $$.Event(e, {type: "tap"}))
							.trigger(new $$.Event(e, {type: "vclick"}))
						;
					}
					
//					console.log("tap");
				}
				
				r.touchData.singleTouchMoved = true;
			}
			
			for (var j=0;j<now.length;j++) { earlier[j] = now[j]; };

			r.dragData.didDrag = false; // reset for next mousedown

			if( updateStartStyle && start ){
				start.updateStyle(false);
			}

			r.redraw();
			
		}, false);
	};
	
	CanvasRenderer.prototype.init = function() { };
	}
	
	
	// @O High-level collision application functions
	
	/**
	 * Updates bounds of all compounds in the given element list.
	 * Assuming the nodes are sorted top down, i.e. a parent node
	 * always has a lower index than its all children.
	 *
	 * @param elements  set of elements containing both nodes and edges
	 */
	CanvasRenderer.prototype.updateAllCompounds = function(elements)
	{
		// traverse in reverse order, since rendering is top-down,
		// but we need to calculate bounds bottom-up
		for(var i = elements.length - 1; i >= 0; i--)
		{
			if (elements[i].isNode() &&
			    (elements[i]._private.style["width"].value == "auto" ||
			     elements[i]._private.style["height"].value == "auto") &&
			    elements[i].children().length > 0)
			{
				var node = elements[i];
				var bounds = this.calcCompoundBounds(node);

				//console.log("%s : %o", node._private.data.id, bounds);
				node._private.position.x = bounds.x;
				node._private.position.y = bounds.y;
				node._private.autoWidth = bounds.width;
				node._private.autoHeight = bounds.height;
			}
		}

	};

	

	// @O Keyboard functions
	{
	}
	
	// @O Drawing functions
	{
	
	// Resize canvas
	CanvasRenderer.prototype.matchCanvasSize = function(container) {
		var data = this.data; var width = container.clientWidth; var height = container.clientHeight;
		
		var canvas, canvasWidth = width, canvasHeight = height;

		if ('devicePixelRatio' in window) {
			canvasWidth *= devicePixelRatio;
			canvasHeight *= devicePixelRatio;
		}

		for (var i = 0; i < CanvasRenderer.CANVAS_LAYERS; i++) {

			canvas = data.canvases[i];
			
			if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
				
				canvas.width = canvasWidth;
				canvas.height = canvasHeight;

				canvas.style.width = width + 'px';
				canvas.style.height = height + 'px';
			}
		}
		
		for (var i = 0; i < CanvasRenderer.BUFFER_COUNT; i++) {
			
			canvas = data.bufferCanvases[i];
			
			if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
				
				canvas.width = canvasWidth;
				canvas.height = canvasHeight;
			}
		}

		this.data.overlay.style.width = width + 'px';
		this.data.overlay.style.height = height + 'px';
	}




	// Redraw frame
	CanvasRenderer.prototype.redraw = function( forcedContext, drawAll, forcedZoom, forcedPan ) {
		var r = this;
		
		if( this.averageRedrawTime === undefined ){ this.averageRedrawTime = 0; }

		var minRedrawLimit = 1000/60; // people can't see much better than 60fps
		var maxRedrawLimit = 1000; // don't cap max b/c it's more important to be responsive than smooth

		var redrawLimit = this.averageRedrawTime; // estimate the ideal redraw limit based on how fast we can draw

		redrawLimit = Math.max(minRedrawLimit, redrawLimit);
		redrawLimit = Math.min(redrawLimit, maxRedrawLimit);

		//console.log('--\nideal: %i; effective: %i', this.averageRedrawTime, redrawLimit);

		if( this.lastDrawTime === undefined ){ this.lastDrawTime = 0; }

		var nowTime = +new Date;
		var timeElapsed = nowTime - this.lastDrawTime;
		var callAfterLimit = timeElapsed >= redrawLimit;

		if( !forcedContext ){
			if( !callAfterLimit ){
				clearTimeout( this.redrawTimeout );
				this.redrawTimeout = setTimeout(function(){
					r.redraw();
				}, redrawLimit);

				return;
			}

			this.lastDrawTime = nowTime;
		}


		// start on thread ready
		setTimeout(function(){

		var startTime = nowTime;

		var looperMax = 100;
		//console.log('-- redraw --')

		// console.time('init'); for( var looper = 0; looper <= looperMax; looper++ ){
		
		var cy = r.data.cy; var data = r.data; 
		var nodes = r.getCachedNodes(); var edges = r.getCachedEdges();
		r.matchCanvasSize(data.container);

		var zoom = cy.zoom();
		var effectiveZoom = forcedZoom !== undefined ? forcedZoom : zoom;
		var pan = cy.pan();
		var effectivePan = {
			x: pan.x,
			y: pan.y
		};

		if( forcedPan ){
			effectivePan = forcedPan;
		}

		if( 'devicePixelRatio' in window ){
			effectiveZoom *= devicePixelRatio;
			effectivePan.x *= devicePixelRatio;
			effectivePan.y *= devicePixelRatio;
		}
		
		var elements = [];
		for( var i = 0; i < nodes.length; i++ ){
			elements.push( nodes[i] );
		}
		for( var i = 0; i < edges.length; i++ ){
			elements.push( edges[i] );
		}

		// } console.timeEnd('init')

	

		if (data.canvasNeedsRedraw[CanvasRenderer.DRAG] || data.canvasNeedsRedraw[CanvasRenderer.NODE] || drawAll) {
			//NB : VERY EXPENSIVE
			//console.time('edgectlpts'); for( var looper = 0; looper <= looperMax; looper++ ){

			if( r.hideEdgesOnViewport && (r.pinching || r.hoverData.dragging || r.data.wheel || r.swipePanning) ){ 
			} else {
				r.findEdgeControlPoints(edges);
			}

			//} console.timeEnd('edgectlpts')

		

			// console.time('sort'); for( var looper = 0; looper <= looperMax; looper++ ){
			var elements = r.getCachedZSortedEles();
			// } console.timeEnd('sort')

			// console.time('updatecompounds'); for( var looper = 0; looper <= looperMax; looper++ ){
			// no need to update graph if there is no compound node
			if ( cy.hasCompoundNodes() )
			{
				r.updateAllCompounds(elements);
			}
			// } console.timeEnd('updatecompounds')
		}
		
		var elesInDragLayer;
		var elesNotInDragLayer;
		var element;


		// console.time('drawing'); for( var looper = 0; looper <= looperMax; looper++ ){
		if (data.canvasNeedsRedraw[CanvasRenderer.NODE] || drawAll) {
			// console.log("redrawing node layer", data.canvasRedrawReason[CanvasRenderer.NODE]);
		  
		  	if( !elesInDragLayer || !elesNotInDragLayer ){
				elesInDragLayer = [];
				elesNotInDragLayer = [];

				for (var index = 0; index < elements.length; index++) {
					element = elements[index];

					if ( element._private.rscratch.inDragLayer ) {
						elesInDragLayer.push( element );
					} else {
						elesNotInDragLayer.push( element );
					}
				}
			}	

			var context = forcedContext || data.canvases[CanvasRenderer.NODE].getContext("2d");

			context.setTransform(1, 0, 0, 1, 0, 0);
			context.clearRect(0, 0, context.canvas.width, context.canvas.height);
			
			if( !drawAll ){
				context.translate(effectivePan.x, effectivePan.y);
				context.scale(effectiveZoom, effectiveZoom);
			}
			if( forcedPan ){
				context.translate(forcedPan.x, forcedPan.y);
			} 
			if( forcedZoom ){
				context.scale(forcedZoom, forcedZoom);
			}
			
			for (var index = 0; index < elesNotInDragLayer.length; index++) {
				element = elesNotInDragLayer[index];
				
				if (element._private.group == "nodes") {
					r.drawNode(context, element);
					
				} else if (element._private.group == "edges") {
					r.drawEdge(context, element);
				}
			}
			
			for (var index = 0; index < elesNotInDragLayer.length; index++) {
				element = elesNotInDragLayer[index];
				
				if (element._private.group == "nodes") {
					r.drawNodeText(context, element);
				} else if (element._private.group == "edges") {
					r.drawEdgeText(context, element);
				}

				// draw the overlay
				if (element._private.group == "nodes") {
					r.drawNode(context, element, true);
				} else if (element._private.group == "edges") {
					r.drawEdge(context, element, true);
				}
			}
			
			if( !drawAll ){
				data.canvasNeedsRedraw[CanvasRenderer.NODE] = false; data.canvasRedrawReason[CanvasRenderer.NODE] = [];
			}
		}
		
		if (data.canvasNeedsRedraw[CanvasRenderer.DRAG] || drawAll) {
			// console.log("redrawing drag layer", data.canvasRedrawReason[CanvasRenderer.DRAG]);
		  
			if( !elesInDragLayer || !elesNotInDragLayer ){
				elesInDragLayer = [];
				elesNotInDragLayer = [];

				for (var index = 0; index < elements.length; index++) {
					element = elements[index];

					if ( element._private.rscratch.inDragLayer ) {
						elesInDragLayer.push( element );
					} else {
						elesNotInDragLayer.push( element );
					}
				}
			}

			var context = forcedContext || data.canvases[CanvasRenderer.DRAG].getContext("2d");
			
			if( !drawAll ){
				context.setTransform(1, 0, 0, 1, 0, 0);
				context.clearRect(0, 0, context.canvas.width, context.canvas.height);
				
				context.translate(effectivePan.x, effectivePan.y);
				context.scale(effectiveZoom, effectiveZoom);
			} 
			if( forcedPan ){
				context.translate(forcedPan.x, forcedPan.y);
			} 
			if( forcedZoom ){
				context.scale(forcedZoom, forcedZoom);
			}
			
			var element;

			for (var index = 0; index < elesInDragLayer.length; index++) {
				element = elesInDragLayer[index];
				
				if (element._private.group == "nodes") {
					r.drawNode(context, element);
				} else if (element._private.group == "edges") {
					r.drawEdge(context, element);
				}
			}
			
			for (var index = 0; index < elesInDragLayer.length; index++) {
				element = elesInDragLayer[index];
				
				if (element._private.group == "nodes") {
					r.drawNodeText(context, element);
				} else if (element._private.group == "edges") {
					r.drawEdgeText(context, element);
				}

				// draw the overlay
				if (element._private.group == "nodes") {
					r.drawNode(context, element, true);
				} else if (element._private.group == "edges") {
					r.drawEdge(context, element, true);
				}
			}
			
			if( !drawAll ){
				data.canvasNeedsRedraw[CanvasRenderer.DRAG] = false; data.canvasRedrawReason[CanvasRenderer.DRAG] = [];
			}
		}
		
		if (data.canvasNeedsRedraw[CanvasRenderer.SELECT_BOX]) {
			// console.log("redrawing selection box", data.canvasRedrawReason[CanvasRenderer.SELECT_BOX]);
		  
			var context = forcedContext || data.canvases[CanvasRenderer.SELECT_BOX].getContext("2d");
			
			if( !drawAll ){
				context.setTransform(1, 0, 0, 1, 0, 0);
				context.clearRect(0, 0, context.canvas.width, context.canvas.height);
			
				context.translate(effectivePan.x, effectivePan.y);
				context.scale(effectiveZoom, effectiveZoom);		
			} 
			if( forcedPan ){
				context.translate(forcedPan.x, forcedPan.y);
			} 
			if( forcedZoom ){
				context.scale(forcedZoom, forcedZoom);
			}
			
			var coreStyle = cy.style()._private.coreStyle;

			if (data.select[4] == 1) {
				var zoom = data.cy.zoom();
				var borderWidth = coreStyle["selection-box-border-width"].value / zoom;
				
				context.lineWidth = borderWidth;
				context.fillStyle = "rgba(" 
					+ coreStyle["selection-box-color"].value[0] + ","
					+ coreStyle["selection-box-color"].value[1] + ","
					+ coreStyle["selection-box-color"].value[2] + ","
					+ coreStyle["selection-box-opacity"].value + ")";
				
				context.fillRect(
					data.select[0],
					data.select[1],
					data.select[2] - data.select[0],
					data.select[3] - data.select[1]);
				
				if (borderWidth > 0) {
					context.strokeStyle = "rgba(" 
						+ coreStyle["selection-box-border-color"].value[0] + ","
						+ coreStyle["selection-box-border-color"].value[1] + ","
						+ coreStyle["selection-box-border-color"].value[2] + ","
						+ coreStyle["selection-box-opacity"].value + ")";
					
					context.strokeRect(
						data.select[0],
						data.select[1],
						data.select[2] - data.select[0],
						data.select[3] - data.select[1]);
				}
			}

			if( data.bgActivePosistion ){
				var zoom = data.cy.zoom();
				var pos = data.bgActivePosistion;

				context.fillStyle = "rgba(" 
					+ coreStyle["active-bg-color"].value[0] + ","
					+ coreStyle["active-bg-color"].value[1] + ","
					+ coreStyle["active-bg-color"].value[2] + ","
					+ coreStyle["active-bg-opacity"].value + ")";

				context.beginPath();
				context.arc(pos.x, pos.y, coreStyle["active-bg-size"].pxValue / zoom, 0, 2 * Math.PI); 
				context.fill();
			}
			
			if( !drawAll ){
				data.canvasNeedsRedraw[CanvasRenderer.SELECT_BOX] = false; data.canvasRedrawReason[CanvasRenderer.SELECT_BOX] = [];
			}
		}

		if( r.options.showOverlay ){
			var context = data.canvases[CanvasRenderer.OVERLAY].getContext("2d");

			context.lineJoin = 'round';
			context.font = '14px helvetica';
			context.strokeStyle = '#fff';
			context.lineWidth = '4';
			context.fillStyle = '#666';
			context.textAlign = 'right';

			var text = 'cytoscape.js';
			
			var w = context.canvas.width;
			var h = context.canvas.height;
			var p = 4;
			var tw = context.measureText(text).width;
			var th = 14; 

			context.clearRect(0, 0, w, h);
			context.strokeText(text, w - p, h - p);
			context.fillText(text, w - p, h - p);

			data.overlayDrawn = true;
		}

		// } console.timeEnd('drawing')

		var endTime = +new Date;

		if( r.averageRedrawTime === undefined ){
			r.averageRedrawTime = endTime - startTime;
		}

		// use a weighted average with a bias from the previous average so we don't spike so easily
		r.averageRedrawTime = r.averageRedrawTime/2 + (endTime - startTime)/2;
		//console.log('actual: %i, average: %i', endTime - startTime, this.averageRedrawTime);


		if( !forcedContext && !r.initrender ){
			r.initrender = true;
			cy.trigger('initrender');
		}

		// end on thread ready
		}, 0);
	};
	
	var imageCache = {};
	
	// Discard after 5 min. of disuse
	var IMAGE_KEEP_TIME = 30 * 300; // 300frames@30fps, or. 5min
	
	CanvasRenderer.prototype.getCachedImage = function(url, onLoadRedraw) {

		if (imageCache[url] && imageCache[url].image) {

			// Reset image discard timer
			imageCache[url].keepTime = IMAGE_KEEP_TIME; 
			return imageCache[url].image;
		}
		
		var imageContainer = imageCache[url];
		
		if (imageContainer == undefined) { 
			imageCache[url] = new Object();
			imageCache[url].image = new Image();
			imageCache[url].image.onload = onLoadRedraw;
			
			imageCache[url].image.src = url;
			
			// Initialize image discard timer
			imageCache[url].keepTime = IMAGE_KEEP_TIME;
			
			imageContainer = imageCache[url];
		}
		
		return imageContainer.image;
	}
	
	// Attempt to replace the image object with a canvas buffer to solve zooming problem
	CanvasRenderer.prototype.swapCachedImage = function(url) {
		if (imageCache[url]) {
			
			if (imageCache[url].image
					&& imageCache[url].image.complete) {
				
				var image = imageCache[url].image;
				
				var buffer = document.createElement("canvas");
				buffer.width = image.width;
				buffer.height = image.height;
				
				buffer.getContext("2d").drawImage(image,
						0, 0
					);
				
				imageCache[url].image = buffer;
				imageCache[url].swappedWithCanvas = true;
				
				return buffer;
			} else {
				return null;
			} 
		} else {
			return null;
		}
	}
	
	CanvasRenderer.prototype.updateImageCaches = function() {
		
		for (var url in imageCache) {
			if (imageCache[url].keepTime <= 0) {
				
				if (imageCache[url].image != undefined) {
					imageCache[url].image.src = undefined;
					imageCache[url].image = undefined;
				}
				
				imageCache[url] = undefined;
			} else {
				imageCache[url] -= 1;
			}
		}
	}
	
	CanvasRenderer.prototype.drawImage = function(context, x, y, widthScale, heightScale, rotationCW, image) {
		
		image.widthScale = 0.5;
		image.heightScale = 0.5;
		
		image.rotate = rotationCW;
		
		var finalWidth; var finalHeight;
		
		canvas.drawImage(image, x, y);
	}
	
	// Draw edge
	CanvasRenderer.prototype.drawEdge = function(context, edge, drawOverlayInstead) {

		if( !edge.visible() ){
			return;
		}

		if( this.hideEdgesOnViewport && (this.dragData.didDrag || this.pinching || this.hoverData.dragging || this.data.wheel || this.swipePanning) ){ return; } // save cycles on pinching

		var startNode, endNode;

		startNode = edge.source()[0];
		endNode = edge.target()[0];
		
		if ( 
			   edge._private.style["visibility"].value != "visible"
			|| edge._private.style["display"].value != "element"
			|| startNode._private.style["visibility"].value != "visible"
			|| startNode._private.style["display"].value != "element"
			|| endNode._private.style["visibility"].value != "visible"
			|| endNode._private.style["display"].value != "element"
		){
			return;
		}
		
		var overlayPadding = edge._private.style["overlay-padding"].value;
		var overlayOpacity = edge._private.style["overlay-opacity"].value;
		var overlayColor = edge._private.style["overlay-color"].value;

		// Edge color & opacity
		if( drawOverlayInstead ){
			context.strokeStyle = "rgba( " + overlayColor[0] + ", " + overlayColor[1] + ", " + overlayColor[2] + ", " + overlayOpacity + " )";
			context.lineCap = "round";

			if( edge._private.rscratch.edgeType == "self"){
				context.lineCap = "butt";
			}

		} else {
			context.strokeStyle = "rgba(" 
				+ edge._private.style["line-color"].value[0] + ","
				+ edge._private.style["line-color"].value[1] + ","
				+ edge._private.style["line-color"].value[2] + ","
				+ edge._private.style.opacity.value + ")";
		}

		// Edge line width
		if (edge._private.style["width"].value <= 0) {
			return;
		}
		
		var edgeWidth = edge._private.style["width"].value + (drawOverlayInstead ? 2 * overlayPadding : 0);
		var lineStyle = drawOverlayInstead ? "solid" : edge._private.style["line-style"].value;
		context.lineWidth = edgeWidth;
		
		this.findEndpoints(edge);
		
		if (edge._private.rscratch.edgeType == "self") {
					
			var details = edge._private.rscratch;
			this.drawStyledEdge(edge, context, [details.startX, details.startY, details.cp2ax,
				details.cp2ay, details.selfEdgeMidX, details.selfEdgeMidY],
				lineStyle,
				edgeWidth);
			
			this.drawStyledEdge(edge, context, [details.selfEdgeMidX, details.selfEdgeMidY,
				details.cp2cx, details.cp2cy, details.endX, details.endY],
				lineStyle,
				edgeWidth);
			
		} else if (edge._private.rscratch.edgeType == "straight") {
			
			var nodeDirectionX = endNode._private.position.x - startNode._private.position.x;
			var nodeDirectionY = endNode._private.position.y - startNode._private.position.y;
			
			var edgeDirectionX = edge._private.rscratch.endX - edge._private.rscratch.startX;
			var edgeDirectionY = edge._private.rscratch.endY - edge._private.rscratch.startY;
			
			if (nodeDirectionX * edgeDirectionX
				+ nodeDirectionY * edgeDirectionY < 0) {
				
				edge._private.rscratch.straightEdgeTooShort = true;	
			} else {
				
				var details = edge._private.rscratch;
				this.drawStyledEdge(edge, context, [details.startX, details.startY,
				                              details.endX, details.endY],
				                              lineStyle,
				                              edgeWidth);
				
				edge._private.rscratch.straightEdgeTooShort = false;	
			}	
		} else {
			
			var details = edge._private.rscratch;
			this.drawStyledEdge(edge, context, [details.startX, details.startY,
				details.cp2x, details.cp2y, details.endX, details.endY],
				lineStyle,
				edgeWidth);
			
		}
		
		if (edge._private.rscratch.noArrowPlacement !== true
				&& edge._private.rscratch.startX !== undefined) {
			this.drawArrowheads(context, edge, drawOverlayInstead);
		}

	}
	
	var _genPoints = function(pt, spacing, even) {
		
		var approxLen = Math.sqrt(Math.pow(pt[4] - pt[0], 2) + Math.pow(pt[5] - pt[1], 2));
		approxLen += Math.sqrt(Math.pow((pt[4] + pt[0]) / 2 - pt[2], 2) + Math.pow((pt[5] + pt[1]) / 2 - pt[3], 2));

		var pts = Math.ceil(approxLen / spacing); var inc = approxLen / spacing;
		var pz;
		
		if (pts > 0) {
			pz = new Array(pts * 2);
		} else {
			return null;
		}
		
		for (var i = 0; i < pts; i++) {
			var cur = i / pts;
			pz[i * 2] = pt[0] * (1 - cur) * (1 - cur) + 2 * (pt[2]) * (1 - cur) * cur + pt[4] * (cur) * (cur);
			pz[i * 2 + 1] = pt[1] * (1 - cur) * (1 - cur) + 2 * (pt[3]) * (1 - cur) * cur + pt[5] * (cur) * (cur);
		}
		
		return pz;
	}
	
	var _genStraightLinePoints = function(pt, spacing, even) {
		
		var approxLen = Math.sqrt(Math.pow(pt[2] - pt[0], 2) + Math.pow(pt[3] - pt[1], 2));
		
		var pts = Math.ceil(approxLen / spacing);
		var pz;
		
		if (pts > 0) {
			pz = new Array(pts * 2);
		} else {
			return null;
		}
		
		var lineOffset = [pt[2] - pt[0], pt[3] - pt[1]];
		for (var i = 0; i < pts; i++) {
			var cur = i / pts;
			pz[i * 2] = lineOffset[0] * cur + pt[0];
			pz[i * 2 + 1] = lineOffset[1] * cur + pt[1];
		}
		
		return pz;
	}
	
	var _genEvenOddpts = function(pt, evenspac, oddspac) {
		
		pt1 = _genpts(pt, evenspac);
		pt2 = _genpts(pt, oddspac);
	}
	
	CanvasRenderer.prototype.createBuffer = function(w, h) {
		var buffer = document.createElement("canvas");
		buffer.width = w;
		buffer.height = h;
		
		return [buffer, buffer.getContext("2d")];
	}
	
	/*
	CanvasRenderer.prototype.
	
	CanvasRenderer.prototype.drawStraightEdge = function(context, x1, y1, x2, y2, type, width) {
		
		if (type == "solid") {
			context.beginPath();
			context.moveTo(
				edge._private.rscratch.startX,
				edge._private.rscratch.startY);
	
			
			context.stroke();
		} else if (type == "dotted") {
			var pt = _genStraightLinePoints([x1, y1, x2, y2], 10, false);
			
			
		} else if (type == "dashed") {
			var pt = _genStraightLinePoints([x1, y1, x2, y2], 10, false);
		}
		
	}
	*/
	
	CanvasRenderer.prototype.drawStyledEdge = function(
			edge, context, pts, type, width) {
		
		// 3 points given -> assume Bezier
		// 2 -> assume straight
		
		var cy = this.data.cy;
		var zoom = cy.zoom();
		
		// Adjusted edge width for dotted
//		width = Math.max(width * 1.6, 3.4) * zoom;

		//		console.log("w", width);
		
		// from http://en.wikipedia.org/wiki/Bézier_curve#Quadratic_curves
		function qbezierAt(p0, p1, p2, t){
			return (1 - t)*(1 - t)*p0 + 2*(1 - t)*t*p1 + t*t*p2;
		}

		if( edge._private.rstyle.bezierPts === undefined ){
			edge._private.rstyle.bezierPts = [];
		}

		var nBpts = edge._private.rstyle.bezierPts.length;
		if( edge.isLoop() ){
			if( nBpts >= 12 ){
				edge._private.rstyle.bezierPts = [];
			} else {
				// append to current array
			}
		} else {
			edge._private.rstyle.bezierPts = [];
		}

		var bpts = edge._private.rstyle.bezierPts;

		if( pts.length === 6 ){
			bpts.push({
				x: qbezierAt( pts[0], pts[2], pts[4], 0.05 ),
				y: qbezierAt( pts[1], pts[3], pts[5], 0.05 )
			});

			bpts.push({
				x: qbezierAt( pts[0], pts[2], pts[4], 0.25 ),
				y: qbezierAt( pts[1], pts[3], pts[5], 0.25 )
			});

			bpts.push({
				x: qbezierAt( pts[0], pts[2], pts[4], 0.35 ),
				y: qbezierAt( pts[1], pts[3], pts[5], 0.35 )
			});

			bpts.push({
				x: qbezierAt( pts[0], pts[2], pts[4], 0.65 ),
				y: qbezierAt( pts[1], pts[3], pts[5], 0.65 )
			});

			bpts.push({
				x: qbezierAt( pts[0], pts[2], pts[4], 0.75 ),
				y: qbezierAt( pts[1], pts[3], pts[5], 0.75 )
			});

			bpts.push({
				x: qbezierAt( pts[0], pts[2], pts[4], 0.95 ),
				y: qbezierAt( pts[1], pts[3], pts[5], 0.95 )
			});
		}

		if (type == "solid") {
			
			context.beginPath();
			context.moveTo(pts[0], pts[1]);
			if (pts.length == 3 * 2) {
				context.quadraticCurveTo(pts[2], pts[3], pts[4], pts[5]);
			} else {
				context.lineTo(pts[2], pts[3]);
			}
//			context.closePath();
			context.stroke();
			
		} else if (type == "dotted") {
			
			var pt;
			if (pts.length == 3 * 2) {
				pt = _genPoints(pts, 16, true);
			} else {
				pt = _genStraightLinePoints(pts, 16, true);
			}
			
			if (!pt) { return; }
			
			var dotRadius = Math.max(width * 1.6, 3.4) * zoom;
			var bufW = dotRadius * 2, bufH = dotRadius * 2;
			bufW = Math.max(bufW, 1);
			bufH = Math.max(bufH, 1);
			
			var buffer = this.createBuffer(bufW, bufH);
			
			var context2 = buffer[1];
//			console.log(buffer);
//			console.log(bufW, bufH);
			
			// Draw on buffer
			context2.setTransform(1, 0, 0, 1, 0, 0);
			context2.clearRect(0, 0, bufW, bufH);
			
			context2.fillStyle = context.strokeStyle;
			context2.beginPath();
			context2.arc(bufW/2, bufH/2, dotRadius * 0.5, 0, Math.PI * 2, false);
			context2.fill();
			
			// Now use buffer
			context.beginPath();
			//context.save();
			
			for (var i=0; i<pt.length/2; i++) {
				
//				context.beginPath();
//				context.arc(pt[i*2], pt[i*2+1], width * 0.5, 0, Math.PI * 2, false);
//				context.fill();
				
				context.drawImage(
						buffer[0],
						pt[i*2] - bufW/2 / zoom,
						pt[i*2+1] - bufH/2 / zoom,
						bufW / zoom,
						bufH / zoom);
			}
			
			//context.restore();
			
		} else if (type == "dashed") {
			var pt;
			if (pts.length == 3 * 2) {
				pt = _genPoints(pts, 14, true);
			} else {
				pt = _genStraightLinePoints(pts, 14, true);
			}
			if (!pt) { return; }
			
//			var dashSize = Math.max(width * 1.6, 3.4);
//			dashSize = Math.min(dashSize)
			
			//var bufW = width * 2 * zoom, bufH = width * 2.5 * zoom;
			var bufW = width * 2 * zoom
			var bufH = 7.8 * zoom;
			bufW = Math.max(bufW, 1);
			bufH = Math.max(bufH, 1);
			
			var buffer = this.createBuffer(bufW, bufH);
			var context2 = buffer[1];

			// Draw on buffer
			context2.setTransform(1, 0, 0, 1, 0, 0);
			context2.clearRect(0, 0, bufW, bufH);
			
			if (context.strokeStyle) {
				context2.strokeStyle = context.strokeStyle;
			}
			
			context2.lineWidth = width * cy.zoom();
			
	//		context2.fillStyle = context.strokeStyle;
			
			context2.beginPath();
			context2.moveTo(bufW / 2, bufH * 0.2);
			context2.lineTo(bufW / 2,  bufH * 0.8);
			
	//		context2.arc(bufH, dotRadius, dotRadius * 0.5, 0, Math.PI * 2, false);
			
	//		context2.fill();
			context2.stroke();
			
			//context.save();
			
			// document.body.appendChild(buffer[0]);
			
			var quadraticBezierVaryingTangent = false;
			var rotateVector, angle;
			
			// Straight line; constant tangent angle
			if (pts.length == 2 * 2) {
				rotateVector = [pts[2] - pts[0], pts[3] - pt[1]];
				
				angle = Math.acos((rotateVector[0] * 0 + rotateVector[1] * -1) / Math.sqrt(rotateVector[0] * rotateVector[0] 
						+ rotateVector[1] * rotateVector[1]));
	
				if (rotateVector[0] < 0) {
					angle = -angle + 2 * Math.PI;
				}
			} else if (pts.length == 3 * 2) {
				quadraticBezierVaryingTangent = true;
			}
			
			for (var i=0; i<pt.length/2; i++) {
				
				var p = i / (Math.max(pt.length/2 - 1, 1));
			
				// Quadratic bezier; varying tangent
				// So, use derivative of quadratic Bezier function to find tangents
				if (quadraticBezierVaryingTangent) {
					rotateVector = [2 * (1-p) * (pts[2] - pts[0]) 
					                	+ 2 * p * (pts[4] - pts[2]),
					                    2 * (1-p) * (pts[3] - pts[1]) 
					                    + 2 * p * (pts[5] - pts[3])];
	
					angle = Math.acos((rotateVector[0] * 0 + rotateVector[1] * -1) / Math.sqrt(rotateVector[0] * rotateVector[0] 
								+ rotateVector[1] * rotateVector[1]));
	
					if (rotateVector[0] < 0) {
						angle = -angle + 2 * Math.PI;
					}
				}
				
				context.translate(pt[i*2], pt[i*2+1]);
				
				context.rotate(angle);
				context.translate(-bufW/2 / zoom, -bufH/2 / zoom);
				
				context.drawImage(
						buffer[0],
						0,
						0,
						bufW / zoom,
						bufH / zoom);
				
				context.translate(bufW/2 / zoom, bufH/2 / zoom);
				context.rotate(-angle);
				
				context.translate(-pt[i*2], -pt[i*2+1]);
				
			}
			
			
			//context.restore();
		} else {
			this.drawStyledEdge(edge, context, pts, "solid", width);
		}
		
	};
	
	// Draw edge text
	CanvasRenderer.prototype.drawEdgeText = function(context, edge) {
	
		if( !edge.visible() ){
			return;
		}

		if( this.hideEdgesOnViewport && (this.dragData.didDrag || this.pinching || this.hoverData.dragging || this.data.wheel || this.swipePanning) ){ return; } // save cycles on pinching

		var computedSize = edge._private.style["font-size"].pxValue * edge.cy().zoom();
		var minSize = edge._private.style["min-zoomed-font-size"].pxValue;

		if( computedSize < minSize ){
			return;
		}
	
		// Calculate text draw position
		
		context.textAlign = "center";
		context.textBaseline = "middle";
		
		var textX, textY;	
		var edgeCenterX, edgeCenterY;
		
		if (edge._private.rscratch.edgeType == "self") {
			edgeCenterX = edge._private.rscratch.selfEdgeMidX;
			edgeCenterY = edge._private.rscratch.selfEdgeMidY;
		} else if (edge._private.rscratch.edgeType == "straight") {
			edgeCenterX = (edge._private.rscratch.startX
				+ edge._private.rscratch.endX) / 2;
			edgeCenterY = (edge._private.rscratch.startY
				+ edge._private.rscratch.endY) / 2;
		} else if (edge._private.rscratch.edgeType == "bezier") {
			edgeCenterX = 0.25 * edge._private.rscratch.startX
				+ 2 * 0.5 * 0.5 * edge._private.rscratch.cp2x
				+ (0.5 * 0.5) * edge._private.rscratch.endX;
			edgeCenterY = Math.pow(1 - 0.5, 2) * edge._private.rscratch.startY
				+ 2 * (1 - 0.5) * 0.5 * edge._private.rscratch.cp2y
				+ (0.5 * 0.5) * edge._private.rscratch.endY;
		}
		
		textX = edgeCenterX;
		textY = edgeCenterY;

		// add center point to style so bounding box calculations can use it
		var rstyle = edge._private.rstyle;
		rstyle.labelX = textX;
		rstyle.labelY = textY;
		
		this.drawText(context, edge, textX, textY);
	};
	
	// Draw node
	CanvasRenderer.prototype.drawNode = function(context, node, drawOverlayInstead) {

		var nodeWidth, nodeHeight;
		
		if ( !node.visible() ) {
			return;
		}

		var parentOpacity = 1;
		var parents = node.parents();
		for( var i = 0; i < parents.length; i++ ){
			var parent = parents[i];
			var opacity = parent._private.style.opacity.value;

			parentOpacity = opacity * parentOpacity;

			if( opacity === 0 ){
				return;
			}
		}
		
		nodeWidth = this.getNodeWidth(node);
		nodeHeight = this.getNodeHeight(node);
		
		context.lineWidth = node._private.style["border-width"].pxValue;

		if( drawOverlayInstead === undefined || !drawOverlayInstead ){

			// Node color & opacity
			context.fillStyle = "rgba(" 
				+ node._private.style["background-color"].value[0] + ","
				+ node._private.style["background-color"].value[1] + ","
				+ node._private.style["background-color"].value[2] + ","
				+ (node._private.style["background-opacity"].value 
				* node._private.style["opacity"].value * parentOpacity) + ")";
			
			// Node border color & opacity
			context.strokeStyle = "rgba(" 
				+ node._private.style["border-color"].value[0] + ","
				+ node._private.style["border-color"].value[1] + ","
				+ node._private.style["border-color"].value[2] + ","
				+ (node._private.style["border-opacity"].value * node._private.style["opacity"].value * parentOpacity) + ")";
			
			
			{
				//var image = this.getCachedImage("url");
				
				var url = node._private.style["background-image"].value[2] ||
					node._private.style["background-image"].value[1];
				
				if (url != undefined) {
					
					var r = this;
					var image = this.getCachedImage(url,
							
							function() {
								
	//							console.log(e);
								r.data.canvasNeedsRedraw[CanvasRenderer.NODE] = true;
								r.data.canvasRedrawReason[CanvasRenderer.NODE].push("image finished load");
								r.data.canvasNeedsRedraw[CanvasRenderer.DRAG] = true;
								r.data.canvasRedrawReason[CanvasRenderer.DRAG].push("image finished load");
								
								// Replace Image object with Canvas to solve zooming too far
								// into image graphical errors (Jan 10 2013)
								r.swapCachedImage(url);
								
								r.redraw();
							}
					);
					
					if (image.complete == false) {

						CanvasRenderer.nodeShapes[r.getNodeShape(node)].drawPath(
							context,
							node._private.position.x,
							node._private.position.y,
						    nodeWidth, nodeHeight);
							//node._private.style["width"].value,
							//node._private.style["height"].value);
						
						context.stroke();
						context.fillStyle = "#555555";
						context.fill();
						
					} else {
						//context.clip
						this.drawInscribedImage(context, image, node);
					}
					
				} else {

					// Draw node
					CanvasRenderer.nodeShapes[this.getNodeShape(node)].draw(
						context,
						node._private.position.x,
						node._private.position.y,
						nodeWidth,
						nodeHeight); //node._private.data.weight / 5.0
				}
				
			}
			
			// Border width, draw border
			if (node._private.style["border-width"].value > 0) {
				context.stroke();
			}
			

		// draw the overlay
		} else {

			var overlayPadding = node._private.style["overlay-padding"].value;
			var overlayOpacity = node._private.style["overlay-opacity"].value;
			var overlayColor = node._private.style["overlay-color"].value;
			if( overlayOpacity > 0 ){
				context.fillStyle = "rgba( " + overlayColor[0] + ", " + overlayColor[1] + ", " + overlayColor[2] + ", " + overlayOpacity + " )";

				CanvasRenderer.nodeShapes[this.getNodeShape(node)].draw(
					context,
					node._private.position.x,
					node._private.position.y,
					nodeWidth + overlayPadding * 2,
					nodeHeight + overlayPadding * 2
				);
			}
		}

	};
	
	CanvasRenderer.prototype.drawInscribedImage = function(context, img, node) {
		var r = this;
//		console.log(this.data);
		var zoom = this.data.cy._private.zoom;
		
		var nodeX = node._private.position.x;
		var nodeY = node._private.position.y;

		//var nodeWidth = node._private.style["width"].value;
		//var nodeHeight = node._private.style["height"].value;
		var nodeWidth = this.getNodeWidth(node);
		var nodeHeight = this.getNodeHeight(node);
		
		context.save();
		
		CanvasRenderer.nodeShapes[r.getNodeShape(node)].drawPath(
				context,
				nodeX, nodeY, 
				nodeWidth, nodeHeight);
		
		context.clip();
		
//		context.setTransform(1, 0, 0, 1, 0, 0);
		
		var imgDim = [img.width, img.height];
		context.drawImage(img, 
				nodeX - imgDim[0] / 2,
				nodeY - imgDim[1] / 2,
				imgDim[0],
				imgDim[1]);
		
		context.restore();
		
		if (node._private.style["border-width"].value > 0) {
			context.stroke();
		}
		
	};
	
	// Draw node text
	CanvasRenderer.prototype.drawNodeText = function(context, node) {
		
		if ( !node.visible() ) {
			return;
		}

		var computedSize = node._private.style["font-size"].pxValue * node.cy().zoom();
		var minSize = node._private.style["min-zoomed-font-size"].pxValue;

		if( computedSize < minSize ){
			return;
		}
	
		var textX, textY;

		//var nodeWidth = node._private.style["width"].value;
		//var nodeHeight = node._private.style["height"].value;
		var nodeWidth = this.getNodeWidth(node);
		var nodeHeight = this.getNodeHeight(node);
	
		// Find text position
		var textHalign = node._private.style["text-halign"].strValue;
		if (textHalign == "left") {
			// Align right boundary of text with left boundary of node
			context.textAlign = "right";
			textX = node._private.position.x - nodeWidth / 2;
		} else if (textHalign == "right") {
			// Align left boundary of text with right boundary of node
			context.textAlign = "left";
			textX = node._private.position.x + nodeWidth / 2;
		} else if (textHalign == "center") {
			context.textAlign = "center";
			textX = node._private.position.x;
		} else {
			// Same as center
			context.textAlign = "center";
			textX = node._private.position.x;
		}
		
		var textValign = node._private.style["text-valign"].strValue;
		if (textValign == "top") {
			context.textBaseline = "bottom";
			textY = node._private.position.y - nodeHeight / 2;
		} else if (textValign == "bottom") {
			context.textBaseline = "top";
			textY = node._private.position.y + nodeHeight / 2;
		} else if (textValign == "middle" || textValign == "center") {
			context.textBaseline = "middle";
			textY = node._private.position.y;
		} else {
			// same as center
			context.textBaseline = "middle";
			textY = node._private.position.y;
		}
		
		this.drawText(context, node, textX, textY);
	};
	
	// Draw text
	CanvasRenderer.prototype.drawText = function(context, element, textX, textY) {
	
		var parentOpacity = 1;
		var parents = element.parents();
		for( var i = 0; i < parents.length; i++ ){
			var parent = parents[i];
			var opacity = parent._private.style.opacity.value;

			parentOpacity = opacity * parentOpacity;

			if( opacity === 0 ){
				return;
			}
		}

		// Font style
		var labelStyle = element._private.style["font-style"].strValue;
		var labelSize = element._private.style["font-size"].value + "px";
		var labelFamily = element._private.style["font-family"].strValue;
		var labelVariant = element._private.style["font-variant"].strValue;
		var labelWeight = element._private.style["font-weight"].strValue;
		
		context.font = labelStyle + " " + labelWeight + " "
			+ labelSize + " " + labelFamily;
		
		var text = String(element._private.style["content"].value);
		var textTransform = element._private.style["text-transform"].value;
		
		if (textTransform == "none") {
		} else if (textTransform == "uppercase") {
			text = text.toUpperCase();
		} else if (textTransform == "lowercase") {
			text = text.toLowerCase();
		}
		
		// Calculate text draw position based on text alignment
		
		// so text outlines aren't jagged
		context.lineJoin = 'round';

		context.fillStyle = "rgba(" 
			+ element._private.style["color"].value[0] + ","
			+ element._private.style["color"].value[1] + ","
			+ element._private.style["color"].value[2] + ","
			+ (element._private.style["text-opacity"].value
			* element._private.style["opacity"].value * parentOpacity) + ")";
		
		context.strokeStyle = "rgba(" 
			+ element._private.style["text-outline-color"].value[0] + ","
			+ element._private.style["text-outline-color"].value[1] + ","
			+ element._private.style["text-outline-color"].value[2] + ","
			+ (element._private.style["text-opacity"].value
			* element._private.style["opacity"].value * parentOpacity) + ")";
		
		if (text != undefined) {
			var lineWidth = 2  * element._private.style["text-outline-width"].value; // *2 b/c the stroke is drawn centred on the middle
			if (lineWidth > 0) {
				context.lineWidth = lineWidth;
				context.strokeText(text, textX, textY);
			}

			// Thanks sysord@github for the isNaN checks!
			if (isNaN(textX)) { textX = 0; }
			if (isNaN(textY)) { textY = 0; }

			context.fillText("" + text, textX, textY);

			// record the text's width for use in bounding box calc
			element._private.rstyle.labelWidth = context.measureText( text ).width;
		}
	};

	CanvasRenderer.prototype.drawBackground = function(context, color1, color2, 
			startPosition, endPosition) {
	
		
	}
	
	// @O Edge calculation functions
	{
	
	// Find edge control points
	CanvasRenderer.prototype.findEdgeControlPoints = function(edges) {
		var hashTable = {}; var cy = this.data.cy;
		var pairIds = [];
		
		var pairId;
		for (var i = 0; i < edges.length; i++){

			// ignore edges who are not to be displayed
			// they shouldn't take up space
			if( edges[i]._private.style.display.value === 'none' ){
				continue;
			}

			pairId = edges[i]._private.data.source > edges[i]._private.data.target ?
				edges[i]._private.data.target + '-' + edges[i]._private.data.source :
				edges[i]._private.data.source + '-' + edges[i]._private.data.target ;

			if (hashTable[pairId] == undefined) {
				hashTable[pairId] = [];
			}
			
			hashTable[pairId].push( edges[i] );
			pairIds.push( pairId );
		}
		var src, tgt;
		
		// Nested for loop is OK; total number of iterations for both loops = edgeCount	
		for (var p = 0; p < pairIds.length; p++) {
			pairId = pairIds[p];
		
			src = cy.getElementById( hashTable[pairId][0]._private.data.source );
			tgt = cy.getElementById( hashTable[pairId][0]._private.data.target );

			var midPointX = (src._private.position.x + tgt._private.position.x) / 2;
			var midPointY = (src._private.position.y + tgt._private.position.y) / 2;
			
			var displacementX, displacementY;
			
			if (hashTable[pairId].length > 1) {
				displacementX = tgt._private.position.y - src._private.position.y;
				displacementY = src._private.position.x - tgt._private.position.x;
				
				var displacementLength = Math.sqrt(displacementX * displacementX
					+ displacementY * displacementY);
				
				displacementX /= displacementLength;
				displacementY /= displacementLength;
			}
			
			var edge;
			
			for (var i = 0; i < hashTable[pairId].length; i++) {
				edge = hashTable[pairId][i];
				
				var edgeIndex1 = edge._private.rscratch.lastEdgeIndex;
				var edgeIndex2 = i;

				var numEdges1 = edge._private.rscratch.lastNumEdges;
				var numEdges2 = hashTable[pairId].length;

				var srcX1 = edge._private.rscratch.lastSrcCtlPtX;
				var srcX2 = src._private.position.x;
				var srcY1 = edge._private.rscratch.lastSrcCtlPtY;
				var srcY2 = src._private.position.y;
				var srcW1 = edge._private.rscratch.lastSrcCtlPtW;
				var srcW2 = src.outerWidth();
				var srcH1 = edge._private.rscratch.lastSrcCtlPtH;
				var srcH2 = src.outerHeight();

				var tgtX1 = edge._private.rscratch.lastTgtCtlPtX;
				var tgtX2 = tgt._private.position.x;
				var tgtY1 = edge._private.rscratch.lastTgtCtlPtY;
				var tgtY2 = tgt._private.position.y;
				var tgtW1 = edge._private.rscratch.lastTgtCtlPtW;
				var tgtW2 = tgt.outerWidth();
				var tgtH1 = edge._private.rscratch.lastTgtCtlPtH;
				var tgtH2 = tgt.outerHeight();

				if( srcX1 === srcX2 && srcY1 === srcY2 && srcW1 === srcW2 && srcH1 === srcH2
				&&  tgtX1 === tgtX2 && tgtY1 === tgtY2 && tgtW1 === tgtW2 && tgtH1 === tgtH2
				&&  edgeIndex1 === edgeIndex2 && numEdges1 === numEdges2 ){
					// console.log('edge ctrl pt cache HIT')
					continue; // then the control points haven't changed and we can skip calculating them
				} else {
					var rs = edge._private.rscratch;

					rs.lastSrcCtlPtX = srcX2;
					rs.lastSrcCtlPtY = srcY2;
					rs.lastSrcCtlPtW = srcW2;
					rs.lastSrcCtlPtH = srcH2;
					rs.lastTgtCtlPtX = tgtX2;
					rs.lastTgtCtlPtY = tgtY2;
					rs.lastTgtCtlPtW = tgtW2;
					rs.lastTgtCtlPtH = tgtH2;
					rs.lastEdgeIndex = edgeIndex2;
					rs.lastNumEdges = numEdges2;
					// console.log('edge ctrl pt cache MISS')
				}

				// Self-edge
				if (src._private.data.id == tgt._private.data.id) {
					var stepSize = edge._private.style["control-point-step-size"].pxValue;
						
					edge._private.rscratch.edgeType = "self";
					
					// New -- fix for large nodes
					edge._private.rscratch.cp2ax = src._private.position.x;
					edge._private.rscratch.cp2ay = src._private.position.y
						- (1 + Math.pow(this.getNodeHeight(src), 1.12) / 100) * stepSize * (i / 3 + 1);
					
					edge._private.rscratch.cp2cx = src._private.position.x
						- (1 + Math.pow(this.getNodeWidth(src), 1.12) / 100) * stepSize * (i / 3 + 1);
					edge._private.rscratch.cp2cy = src._private.position.y;
					
					edge._private.rscratch.selfEdgeMidX =
						(edge._private.rscratch.cp2ax + edge._private.rscratch.cp2cx) / 2.0;
				
					edge._private.rscratch.selfEdgeMidY =
						(edge._private.rscratch.cp2ay + edge._private.rscratch.cp2cy) / 2.0;
					
				// Straight edge
				} else if (hashTable[pairId].length % 2 == 1
					&& i == Math.floor(hashTable[pairId].length / 2)) {
					
					edge._private.rscratch.edgeType = "straight";
					
				// Bezier edge
				} else {
					var stepSize = edge._private.style["control-point-step-size"].value;
					var distanceFromMidpoint = (0.5 - hashTable[pairId].length / 2 + i) * stepSize;
					
					edge._private.rscratch.edgeType = "bezier";
					
					edge._private.rscratch.cp2x = midPointX
						+ displacementX * distanceFromMidpoint;
					edge._private.rscratch.cp2y = midPointY
						+ displacementY * distanceFromMidpoint;
					
					// console.log(edge, midPointX, displacementX, distanceFromMidpoint);
				}
			}
		}
		
		return hashTable;
	}

	CanvasRenderer.prototype.findEndpoints = function(edge) {
		var intersect;

		var source = edge.source()[0];
		var target = edge.target()[0];
		
//		var sourceRadius = Math.max(edge.source()[0]._private.style["width"].value,
//			edge.source()[0]._private.style["height"].value);

		var sourceRadius = Math.max(this.getNodeWidth(source),
			this.getNodeHeight(source));
		
//		var targetRadius = Math.max(edge.target()[0]._private.style["width"].value,
//			edge.target()[0]._private.style["height"].value);

		var targetRadius = Math.max(this.getNodeWidth(target),
			this.getNodeHeight(target));

		sourceRadius = 0;
		targetRadius /= 2;
		
		var start = [edge.source().position().x, edge.source().position().y];
		var end = [edge.target().position().x, edge.target().position().y];
		
		if (edge._private.rscratch.edgeType == "self") {
			
			var cp = [edge._private.rscratch.cp2cx, edge._private.rscratch.cp2cy];
			
			intersect = CanvasRenderer.nodeShapes[this.getNodeShape(target)].intersectLine(
				target._private.position.x,
				target._private.position.y,
				//target._private.style["width"].value,
				//target._private.style["height"].value,
				this.getNodeWidth(target),
				this.getNodeHeight(target),
				cp[0], //halfPointX,
				cp[1], //halfPointY
				target._private.style["border-width"].value / 2
			);
			
			var arrowEnd = $$.math.shortenIntersection(intersect, cp,
				CanvasRenderer.arrowShapes[edge._private.style["target-arrow-shape"].value].spacing(edge));
			var edgeEnd = $$.math.shortenIntersection(intersect, cp,
				CanvasRenderer.arrowShapes[edge._private.style["target-arrow-shape"].value].gap(edge));
			
			edge._private.rscratch.endX = edgeEnd[0];
			edge._private.rscratch.endY = edgeEnd[1];
			
			edge._private.rscratch.arrowEndX = arrowEnd[0];
			edge._private.rscratch.arrowEndY = arrowEnd[1];
			
			var cp = [edge._private.rscratch.cp2ax, edge._private.rscratch.cp2ay];

			intersect = CanvasRenderer.nodeShapes[this.getNodeShape(source)].intersectLine(
				source._private.position.x,
				source._private.position.y,
				//source._private.style["width"].value,
				//source._private.style["height"].value,
				this.getNodeWidth(source),
				this.getNodeHeight(source),
				cp[0], //halfPointX,
				cp[1], //halfPointY
				source._private.style["border-width"].value / 2
			);
			
			var arrowStart = $$.math.shortenIntersection(intersect, cp,
				CanvasRenderer.arrowShapes[edge._private.style["source-arrow-shape"].value].spacing(edge));
			var edgeStart = $$.math.shortenIntersection(intersect, cp,
				CanvasRenderer.arrowShapes[edge._private.style["source-arrow-shape"].value].gap(edge));
			
			edge._private.rscratch.startX = edgeStart[0];
			edge._private.rscratch.startY = edgeStart[1];
			
			edge._private.rscratch.arrowStartX = arrowStart[0];
			edge._private.rscratch.arrowStartY = arrowStart[1];
			
		} else if (edge._private.rscratch.edgeType == "straight") {
		
			intersect = CanvasRenderer.nodeShapes[this.getNodeShape(target)].intersectLine(
				target._private.position.x,
				target._private.position.y,
				//target._private.style["width"].value,
				//target._private.style["height"].value,
				this.getNodeWidth(target),
				this.getNodeHeight(target),
				source.position().x,
				source.position().y,
				target._private.style["border-width"].value / 2);
				
			if (intersect.length == 0) {
				edge._private.rscratch.noArrowPlacement = true;
	//			return;
			} else {
				edge._private.rscratch.noArrowPlacement = false;
			}
			
			var arrowEnd = $$.math.shortenIntersection(intersect,
				[source.position().x, source.position().y],
				CanvasRenderer.arrowShapes[edge._private.style["target-arrow-shape"].value].spacing(edge));
			var edgeEnd = $$.math.shortenIntersection(intersect,
				[source.position().x, source.position().y],
				CanvasRenderer.arrowShapes[edge._private.style["target-arrow-shape"].value].gap(edge));

			edge._private.rscratch.endX = edgeEnd[0];
			edge._private.rscratch.endY = edgeEnd[1];
			
			edge._private.rscratch.arrowEndX = arrowEnd[0];
			edge._private.rscratch.arrowEndY = arrowEnd[1];
		
			intersect = CanvasRenderer.nodeShapes[this.getNodeShape(source)].intersectLine(
				source._private.position.x,
				source._private.position.y,
				//source._private.style["width"].value,
				//source._private.style["height"].value,
				this.getNodeWidth(source),
				this.getNodeHeight(source),
				target.position().x,
				target.position().y,
				source._private.style["border-width"].value / 2);
			
			if (intersect.length == 0) {
				edge._private.rscratch.noArrowPlacement = true;
	//			return;
			} else {
				edge._private.rscratch.noArrowPlacement = false;
			}
			
			/*
			console.log("1: "
				+ CanvasRenderer.arrowShapes[edge._private.style["source-arrow-shape"].value],
					edge._private.style["source-arrow-shape"].value);
			*/
			var arrowStart = $$.math.shortenIntersection(intersect,
				[target.position().x, target.position().y],
				CanvasRenderer.arrowShapes[edge._private.style["source-arrow-shape"].value].spacing(edge));
			var edgeStart = $$.math.shortenIntersection(intersect,
				[target.position().x, target.position().y],
				CanvasRenderer.arrowShapes[edge._private.style["source-arrow-shape"].value].gap(edge));

			edge._private.rscratch.startX = edgeStart[0];
			edge._private.rscratch.startY = edgeStart[1];
			
			edge._private.rscratch.arrowStartX = arrowStart[0];
			edge._private.rscratch.arrowStartY = arrowStart[1];
						
		} else if (edge._private.rscratch.edgeType == "bezier") {
			
			var cp = [edge._private.rscratch.cp2x, edge._private.rscratch.cp2y];
			
			// Point at middle of Bezier
			var halfPointX = start[0] * 0.25 + end[0] * 0.25 + cp[0] * 0.5;
			var halfPointY = start[1] * 0.25 + end[1] * 0.25 + cp[1] * 0.5;
			
			intersect = CanvasRenderer.nodeShapes[
				this.getNodeShape(target)].intersectLine(
				target._private.position.x,
				target._private.position.y,
				//target._private.style["width"].value,
				//target._private.style["height"].value,
				this.getNodeWidth(target),
				this.getNodeHeight(target),
				cp[0], //halfPointX,
				cp[1], //halfPointY
				target._private.style["border-width"].value / 2
			);
			
			/*
			console.log("2: "
				+ CanvasRenderer.arrowShapes[edge._private.style["source-arrow-shape"].value],
					edge._private.style["source-arrow-shape"].value);
			*/
			var arrowEnd = $$.math.shortenIntersection(intersect, cp,
				CanvasRenderer.arrowShapes[edge._private.style["target-arrow-shape"].value].spacing(edge));
			var edgeEnd = $$.math.shortenIntersection(intersect, cp,
				CanvasRenderer.arrowShapes[edge._private.style["target-arrow-shape"].value].gap(edge));
			
			edge._private.rscratch.endX = edgeEnd[0];
			edge._private.rscratch.endY = edgeEnd[1];
			
			edge._private.rscratch.arrowEndX = arrowEnd[0];
			edge._private.rscratch.arrowEndY = arrowEnd[1];
			
			intersect = CanvasRenderer.nodeShapes[
				this.getNodeShape(source)].intersectLine(
				source._private.position.x,
				source._private.position.y,
				//source._private.style["width"].value,
				//source._private.style["height"].value,
				this.getNodeWidth(source),
				this.getNodeHeight(source),
				cp[0], //halfPointX,
				cp[1], //halfPointY
				source._private.style["border-width"].value / 2
			);
			
			var arrowStart = $$.math.shortenIntersection(intersect, cp,
				CanvasRenderer.arrowShapes[edge._private.style["source-arrow-shape"].value].spacing(edge));
			var edgeStart = $$.math.shortenIntersection(intersect, cp,
				CanvasRenderer.arrowShapes[edge._private.style["source-arrow-shape"].value].gap(edge));
			
			edge._private.rscratch.startX = edgeStart[0];
			edge._private.rscratch.startY = edgeStart[1];
			
			edge._private.rscratch.arrowStartX = arrowStart[0];
			edge._private.rscratch.arrowStartY = arrowStart[1];
			
		} else if (edge._private.rscratch.isArcEdge) {
			return;
		}
	}

	}

	// @O Graph traversal functions
	{
	
	// Find adjacent edges
	CanvasRenderer.prototype.findEdges = function(nodeSet) {
		
		var edges = this.getCachedEdges();
		
		var hashTable = {};
		var adjacentEdges = [];
		
		for (var i = 0; i < nodeSet.length; i++) {
			hashTable[nodeSet[i]._private.data.id] = nodeSet[i];
		}
		
		for (var i = 0; i < edges.length; i++) {
			if (hashTable[edges[i]._private.data.source]
				|| hashTable[edges[i]._private.data.target]) {
				
				adjacentEdges.push(edges[i]);
			}
		}
		
		return adjacentEdges;
	}
	
	}
	
	// @O Arrow shapes
	{
	
	
	
	// @O Arrow shape sizing (w + l)
	{
	
	CanvasRenderer.prototype.getArrowWidth = function(edgeWidth) {
		return Math.max(Math.pow(edgeWidth * 13.37, 0.9), 29);
	}
	
	CanvasRenderer.prototype.getArrowHeight = function(edgeWidth) {
		return Math.max(Math.pow(edgeWidth * 13.37, 0.9), 29);
	}
	
	}
	
	// @O Arrow shape drawing
	
	// Draw arrowheads on edge
	CanvasRenderer.prototype.drawArrowheads = function(context, edge, drawOverlayInstead) {
		if( drawOverlayInstead ){ return; } // don't do anything for overlays 

		// Displacement gives direction for arrowhead orientation
		var dispX, dispY;

		var startX = edge._private.rscratch.arrowStartX;
		var startY = edge._private.rscratch.arrowStartY;
		
		dispX = startX - edge.source().position().x;
		dispY = startY - edge.source().position().y;
		
		//this.context.strokeStyle = "rgba("
		context.fillStyle = "rgba("
			+ edge._private.style["source-arrow-color"].value[0] + ","
			+ edge._private.style["source-arrow-color"].value[1] + ","
			+ edge._private.style["source-arrow-color"].value[2] + ","
			+ edge._private.style.opacity.value + ")";
		
		context.lineWidth = edge._private.style["width"].value;
		
		this.drawArrowShape(context, edge._private.style["source-arrow-shape"].value, 
			startX, startY, dispX, dispY);
		
		var endX = edge._private.rscratch.arrowEndX;
		var endY = edge._private.rscratch.arrowEndY;
		
		dispX = endX - edge.target().position().x;
		dispY = endY - edge.target().position().y;
		
		//this.context.strokeStyle = "rgba("
		context.fillStyle = "rgba("
			+ edge._private.style["target-arrow-color"].value[0] + ","
			+ edge._private.style["target-arrow-color"].value[1] + ","
			+ edge._private.style["target-arrow-color"].value[2] + ","
			+ edge._private.style.opacity.value + ")";
		
		context.lineWidth = edge._private.style["width"].value;
		
		this.drawArrowShape(context, edge._private.style["target-arrow-shape"].value,
			endX, endY, dispX, dispY);
	}
	
	// Draw arrowshape
	CanvasRenderer.prototype.drawArrowShape = function(context, shape, x, y, dispX, dispY) {
	
		// Negative of the angle
		var angle = Math.asin(dispY / (Math.sqrt(dispX * dispX + dispY * dispY)));
	
		if (dispX < 0) {
			//context.strokeStyle = "AA99AA";
			angle = angle + Math.PI / 2;
		} else {
			//context.strokeStyle = "AAAA99";
			angle = - (Math.PI / 2 + angle);
		}
		
		//context.save();
		context.translate(x, y);
		
		context.moveTo(0, 0);
		context.rotate(-angle);
		
		var size = this.getArrowWidth(context.lineWidth);
		/// size = 100;
		context.scale(size, size);
		
		context.beginPath();
		
		CanvasRenderer.arrowShapes[shape].draw(context);
		
		context.closePath();
		
//		context.stroke();
		context.fill();

		context.scale(1/size, 1/size);
		context.rotate(angle);
		context.translate(-x, -y);
		//context.restore();
	}

	}
	
	
	// @O Polygon drawing
	CanvasRenderer.prototype.drawPolygonPath = function(
		context, x, y, width, height, points) {

		//context.save();
		

		context.translate(x, y);
		context.scale(width / 2, height / 2);

		context.beginPath();

		context.moveTo(points[0], points[1]);

		for (var i = 1; i < points.length / 2; i++) {
			context.lineTo(points[i * 2], points[i * 2 + 1]);
		}
		
		context.closePath();
		
		context.scale(2/width, 2/height);
		context.translate(-x, -y);
		// context.restore();
	}
	
	CanvasRenderer.prototype.drawPolygon = function(
		context, x, y, width, height, points) {

		// Draw path
		this.drawPolygonPath(context, x, y, width, height, points);
		
		// Fill path
		context.fill();
	}
	
	// Round rectangle drawing
	CanvasRenderer.prototype.drawRoundRectanglePath = function(
		context, x, y, width, height, radius) {
		
		var halfWidth = width / 2;
		var halfHeight = height / 2;
		var cornerRadius = $$.math.getRoundRectangleRadius(width, height);
		context.translate(x, y);
		
		context.beginPath();
		
		// Start at top middle
		context.moveTo(0, -halfHeight);
		// Arc from middle top to right side
		context.arcTo(halfWidth, -halfHeight, halfWidth, 0, cornerRadius);
		// Arc from right side to bottom
		context.arcTo(halfWidth, halfHeight, 0, halfHeight, cornerRadius);
		// Arc from bottom to left side
		context.arcTo(-halfWidth, halfHeight, -halfWidth, 0, cornerRadius);
		// Arc from left side to topBorder
		context.arcTo(-halfWidth, -halfHeight, 0, -halfHeight, cornerRadius);
		// Join line
		context.lineTo(0, -halfHeight);
		
		/*
		void arc(unrestricted double x, 
				 unrestricted double y, 
				 unrestricted double radius, 
				 unrestricted double startAngle, 
				 unrestricted double endAngle, 
				 optional boolean anticlockwise = false);
		*/
		/*
		context.arc(-width / 2 + cornerRadius,
					-height / 2 + cornerRadius,
					cornerRadius,
					0,
					Math.PI * 2 * 0.999);
		*/
		
		context.closePath();
		
		context.translate(-x, -y);
	}
	
	CanvasRenderer.prototype.drawRoundRectangle = function(
		context, x, y, width, height, radius) {
		
		this.drawRoundRectanglePath(context, x, y, width, height, radius);
		
		context.fill();
	}

	
	}

	// copy the math functions into the renderer prototype
	// unfortunately these functions are used interspersed t/o the code
	// and this makes sure things work just in case a ref was missed in refactoring
	// TODO remove this eventually
	for( var fnName in $$.math ){
		CanvasRenderer.prototype[ fnName ] = $$.math[ fnName ];
	}
	
	
	var debug = function(){};
	$$("renderer", "canvas", CanvasRenderer);
	
})( cytoscape );