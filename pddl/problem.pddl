(define (problem deliveroo-sample)
  (:domain deliveroo)
  
  ;; Define the exact tiles and parcels that exist right now
  (:objects 
    loc-0-0 loc-1-0 loc-2-0 - location
    parcel1 - parcel
  )

  ;; Describe the starting state of the board
  (:init 
    ;; Where is the agent?
    (at-agent loc-0-0)
    
    ;; Where are the parcels?
    (at-parcel parcel1 loc-1-0)
    
    ;; Where are the delivery zones?
    (is-delivery-zone loc-2-0)
    
    ;; How are the tiles connected?
    (connected loc-0-0 loc-1-0)
    (connected loc-1-0 loc-0-0)
    
    (connected loc-1-0 loc-2-0)
    (connected loc-2-0 loc-1-0)
  )

  ;; What is the agent trying to achieve?
  (:goal 
    (and 
      (delivered parcel1)
    )
  )
)